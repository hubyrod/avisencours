import { SQL } from "bun";
import type { ClassifiedItem } from "./pipeline.ts";

let client: SQL | null = null;

export function db(): SQL {
  if (client) return client;
  const url = Bun.env.POSTGRESQL_ADDON_URI ?? Bun.env.DATABASE_URL;
  if (!url) {
    throw new Error("POSTGRESQL_ADDON_URI is required — link the PostgreSQL add-on or set it in .env");
  }
  client = new SQL({ url, max: 3 });
  return client;
}

export async function migrate(): Promise<void> {
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS runs (
      id            bigserial PRIMARY KEY,
      started_at    timestamptz NOT NULL DEFAULT now(),
      finished_at   timestamptz,
      status        text NOT NULL DEFAULT 'running',
      error         text,
      total_fetched  int,
      relevant_count int,
      travaux_count  int,
      excluded_count int
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS announcements (
      idweb             text PRIMARY KEY,
      url               text NOT NULL,
      objet             text NOT NULL,
      acheteur          text,
      department        text,
      type_avis         text,
      procedure         text,
      published_at      text,
      deadline          timestamptz,
      deadline_text     text,
      category          text NOT NULL,
      reason            text,
      raw               text,
      first_seen_run_id bigint REFERENCES runs(id),
      first_seen_at     timestamptz NOT NULL DEFAULT now(),
      last_seen_run_id  bigint REFERENCES runs(id)
    )`;
  await sql`CREATE INDEX IF NOT EXISTS announcements_category_deadline ON announcements (category, deadline)`;
}

// Single arbitrary lock id shared by every runner of this app.
const RUN_LOCK_ID = 823741;

export async function tryAcquireRunLock(): Promise<boolean> {
  const rows = await db()`SELECT pg_try_advisory_lock(${RUN_LOCK_ID}) AS locked`;
  return rows[0]?.locked === true;
}

export async function startRun(): Promise<number> {
  const rows = await db()`INSERT INTO runs DEFAULT VALUES RETURNING id`;
  return Number(rows[0].id);
}

export async function finishRun(
  id: number,
  outcome:
    | { status: "success"; totalFetched: number; relevant: number; travaux: number; excluded: number }
    | { status: "error"; error: string },
): Promise<void> {
  if (outcome.status === "success") {
    await db()`
      UPDATE runs SET finished_at = now(), status = 'success',
        total_fetched = ${outcome.totalFetched},
        relevant_count = ${outcome.relevant},
        travaux_count = ${outcome.travaux},
        excluded_count = ${outcome.excluded}
      WHERE id = ${id}`;
  } else {
    await db()`
      UPDATE runs SET finished_at = now(), status = 'error', error = ${outcome.error.slice(0, 4000)}
      WHERE id = ${id}`;
  }
}

// "dd/mm/yyyy à HHhMM" (UTC, as formatted by scraper.ts) -> Date | null
export function parseDeadlineText(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+à\s+(\d{2})h(\d{2}))?/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

export async function upsertAnnouncements(runId: number, items: ClassifiedItem[]): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    for (const it of items) {
      if (!it.idweb) continue;
      await tx`
        INSERT INTO announcements (
          idweb, url, objet, acheteur, department, type_avis, procedure,
          published_at, deadline, deadline_text, category, reason, raw,
          first_seen_run_id, last_seen_run_id
        ) VALUES (
          ${it.idweb}, ${it.url}, ${it.objet}, ${it.acheteur}, ${it.department},
          ${it.typeAvis}, ${it.procedure}, ${it.publishedAt},
          ${parseDeadlineText(it.deadline)}, ${it.deadline},
          ${it.category}, ${it.reason ?? null}, ${it.raw},
          ${runId}, ${runId}
        )
        ON CONFLICT (idweb) DO UPDATE SET
          url = EXCLUDED.url,
          objet = EXCLUDED.objet,
          acheteur = EXCLUDED.acheteur,
          department = EXCLUDED.department,
          type_avis = EXCLUDED.type_avis,
          procedure = EXCLUDED.procedure,
          published_at = EXCLUDED.published_at,
          deadline = EXCLUDED.deadline,
          deadline_text = EXCLUDED.deadline_text,
          category = EXCLUDED.category,
          reason = EXCLUDED.reason,
          raw = EXCLUDED.raw,
          last_seen_run_id = EXCLUDED.last_seen_run_id`;
    }
  });
}

export type StoredAnnouncement = {
  idweb: string;
  url: string;
  objet: string;
  acheteur: string | null;
  department: string | null;
  type_avis: string | null;
  procedure: string | null;
  published_at: string | null;
  deadline: Date | null;
  deadline_text: string | null;
  category: string;
  reason: string | null;
  first_seen_run_id: number | null;
};

export type RunRow = {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  error: string | null;
  total_fetched: number | null;
  relevant_count: number | null;
  travaux_count: number | null;
  excluded_count: number | null;
};

export async function getLastRun(): Promise<RunRow | null> {
  const rows = await db()`SELECT * FROM runs ORDER BY id DESC LIMIT 1`;
  return (rows[0] as RunRow) ?? null;
}

export async function getLastSuccessfulRun(): Promise<RunRow | null> {
  const rows = await db()`SELECT * FROM runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`;
  return (rows[0] as RunRow) ?? null;
}

// Announcements still present in the latest successful run, deadline not passed
// (or unknown), sorted by deadline ascending.
export async function getCurrent(category: string, runId: number): Promise<StoredAnnouncement[]> {
  const rows = await db()`
    SELECT * FROM announcements
    WHERE last_seen_run_id = ${runId}
      AND category = ${category}
      AND (deadline IS NULL OR deadline >= now())
    ORDER BY deadline ASC NULLS LAST, idweb`;
  return rows as StoredAnnouncement[];
}

export async function getNewInRun(runId: number, category: string): Promise<StoredAnnouncement[]> {
  const rows = await db()`
    SELECT * FROM announcements
    WHERE first_seen_run_id = ${runId} AND category = ${category}
    ORDER BY deadline ASC NULLS LAST, idweb`;
  return rows as StoredAnnouncement[];
}

export async function getUpcomingDeadlines(runId: number, days: number): Promise<StoredAnnouncement[]> {
  const rows = await db()`
    SELECT * FROM announcements
    WHERE last_seen_run_id = ${runId}
      AND category = 'relevant'
      AND deadline >= now()
      AND deadline < now() + make_interval(days => ${days})
    ORDER BY deadline ASC, idweb`;
  return rows as StoredAnnouncement[];
}
