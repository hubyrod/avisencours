import { SQL } from "bun";
import type { ClassifiedItem } from "./pipeline.ts";
import { KEYWORDS } from "./defaults.ts";

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
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id             bigserial PRIMARY KEY,
      email          text NOT NULL UNIQUE,
      name           text,
      is_admin       boolean NOT NULL DEFAULT false,
      receive_digest boolean NOT NULL DEFAULT false,
      created_at     timestamptz NOT NULL DEFAULT now(),
      last_login_at  timestamptz
    )`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS receive_digest boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_configure boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS digest_sent boolean NOT NULL DEFAULT false`;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   text PRIMARY KEY,
      user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL
    )`;
  await sql`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id         bigserial PRIMARY KEY,
      email      text NOT NULL,
      code_hash  text NOT NULL,
      purpose    text NOT NULL DEFAULT 'login',
      attempts   int NOT NULL DEFAULT 0,
      expires_at timestamptz NOT NULL,
      used_at    timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS evc_email_idx ON email_verification_codes (email, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS comments (
      id         bigserial PRIMARY KEY,
      idweb      text NOT NULL REFERENCES announcements(idweb) ON DELETE CASCADE,
      user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS comments_idweb_idx ON comments (idweb, created_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS statuses (
      id         bigserial PRIMARY KEY,
      label      text NOT NULL,
      color      text NOT NULL DEFAULT '#626d66',
      position   int NOT NULL,
      archived   boolean NOT NULL DEFAULT false,
      is_rejet   boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS status_events (
      id         bigserial PRIMARY KEY,
      idweb      text NOT NULL REFERENCES announcements(idweb) ON DELETE CASCADE,
      status_id  bigint NOT NULL REFERENCES statuses(id) ON DELETE RESTRICT,
      user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS status_events_idweb_idx ON status_events (idweb, created_at DESC, id DESC)`;
  // Liste de départ, uniquement si la table est vide (la liste vit ensuite dans /admin).
  await sql`
    INSERT INTO statuses (label, color, position, is_rejet)
    SELECT * FROM (VALUES
      ('à évaluer',              '#626d66', 10, false),
      ('il va falloir répondre', '#92600c', 20, false),
      ('on laisse tomber',       '#6b7280', 30, true),
      ('répondu',                '#1d4ed8', 40, false),
      ('gagné',                  '#0c5c46', 50, false),
      ('perdu',                  '#b3261e', 60, false),
      ('bounced',                '#7c4a03', 70, false)
    ) AS seed(label, color, position, is_rejet)
    WHERE NOT EXISTS (SELECT 1 FROM statuses)`;
  await sql`
    CREATE TABLE IF NOT EXISTS search_keywords (
      id         bigserial PRIMARY KEY,
      term       text NOT NULL UNIQUE,
      position   int NOT NULL,
      created_by bigint REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS scope_rules (
      id         bigserial PRIMARY KEY,
      kind       text NOT NULL CHECK (kind IN ('keep', 'exclude')),
      term       text NOT NULL,
      created_by bigint REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (kind, term)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key        text PRIMARY KEY,
      value      text NOT NULL,
      updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  // Mots-clés de départ, uniquement si la table est vide (la liste vit ensuite
  // dans /configuration). Stockés sans guillemets ; le requêtage les recolle.
  const hasKeywords = await sql`SELECT 1 FROM search_keywords LIMIT 1`;
  if (hasKeywords.length === 0) {
    await sql.begin(async (tx) => {
      for (let i = 0; i < KEYWORDS.length; i++) {
        const term = KEYWORDS[i]!.replace(/^"([^"]*)"$/, "$1");
        await tx`
          INSERT INTO search_keywords (term, position)
          VALUES (${term}, ${(i + 1) * 10})
          ON CONFLICT (term) DO NOTHING`;
      }
    });
  }
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
  comment_count?: number;
  status_id?: number | null;
  status_label?: string | null;
  status_color?: string | null;
  status_is_rejet?: boolean | null;
  status_set_at?: Date | null;
  status_set_by_id?: number | null;
  status_set_by_name?: string | null;
  status_set_by_email?: string | null;
};

export type StatusRow = {
  id: number;
  label: string;
  color: string;
  position: number;
  archived: boolean;
  is_rejet: boolean;
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
// (or unknown), sorted by deadline ascending. Statut courant = dernier événement ;
// aucun événement = statut par défaut (premier statut actif par position), d'où
// le COALESCE — le filtre « à évaluer » doit aussi attraper les avis sans événement.
export async function getCurrent(
  category: string,
  runId: number,
  filter?: { statusId?: number | null; hideRejet?: boolean },
): Promise<StoredAnnouncement[]> {
  const statusId = filter?.statusId ?? null;
  const hideRejet = filter?.hideRejet ?? false;
  const defaultId = (await getDefaultStatus())?.id ?? null;
  const rows = await db()`
    SELECT a.*,
      (SELECT count(*)::int FROM comments c WHERE c.idweb = a.idweb) AS comment_count,
      s.id AS status_id, s.label AS status_label, s.color AS status_color, s.is_rejet AS status_is_rejet,
      cur.created_at AS status_set_at, cur.user_id AS status_set_by_id,
      su.name AS status_set_by_name, su.email AS status_set_by_email
    FROM announcements a
    LEFT JOIN LATERAL (
      SELECT e.status_id, e.created_at, e.user_id FROM status_events e
      WHERE e.idweb = a.idweb
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) cur ON true
    LEFT JOIN statuses s ON s.id = COALESCE(cur.status_id, ${defaultId})
    LEFT JOIN users su ON su.id = cur.user_id
    WHERE a.last_seen_run_id = ${runId}
      AND a.category = ${category}
      AND (a.deadline IS NULL OR a.deadline >= now())
      AND (${statusId}::bigint IS NULL OR COALESCE(cur.status_id, ${defaultId}) = ${statusId})
      AND (${hideRejet} = false OR COALESCE(s.is_rejet, false) = false)
    ORDER BY a.deadline ASC NULLS LAST, a.idweb`;
  return rows as StoredAnnouncement[];
}

export async function getAnnouncement(idweb: string): Promise<StoredAnnouncement | null> {
  const rows = await db()`SELECT * FROM announcements WHERE idweb = ${idweb}`;
  return (rows[0] as StoredAnnouncement) ?? null;
}

// La lecture des fils passe par le moteur réactif Skip (src/live.ts) : ici on ne
// garde que l'écriture, que l'adaptateur Postgres répercute via LISTEN/NOTIFY.
export async function addComment(idweb: string, userId: number, body: string): Promise<void> {
  await db()`INSERT INTO comments (idweb, user_id, body) VALUES (${idweb}, ${userId}, ${body})`;
}

// Authors may delete their own comments; admins may delete any.
export async function deleteComment(id: number, userId: number, isAdmin: boolean): Promise<void> {
  if (isAdmin) {
    await db()`DELETE FROM comments WHERE id = ${id}`;
  } else {
    await db()`DELETE FROM comments WHERE id = ${id} AND user_id = ${userId}`;
  }
}

// --- Statuts d'avis (liste gérée dans /admin ; historique en événements) ----------
// Comme pour les commentaires : les écritures restent en SQL simple, la lecture du
// fil (événements interclassés avec les commentaires) passe par Skip (src/live.ts).

export async function listStatuses(includeArchived = false): Promise<StatusRow[]> {
  const rows = includeArchived
    ? await db()`SELECT * FROM statuses ORDER BY position, id`
    : await db()`SELECT * FROM statuses WHERE archived = false ORDER BY position, id`;
  return rows as StatusRow[];
}

export async function getDefaultStatus(): Promise<StatusRow | null> {
  const rows = await db()`SELECT * FROM statuses WHERE archived = false ORDER BY position, id LIMIT 1`;
  return (rows[0] as StatusRow) ?? null;
}

export async function getStatus(id: number): Promise<StatusRow | null> {
  const rows = await db()`SELECT * FROM statuses WHERE id = ${id}`;
  return (rows[0] as StatusRow) ?? null;
}

export async function addStatus(label: string, color: string): Promise<void> {
  await db()`
    INSERT INTO statuses (label, color, position)
    VALUES (${label}, ${color}, (SELECT COALESCE(max(position), 0) + 10 FROM statuses))`;
}

export async function renameStatus(id: number, label: string): Promise<void> {
  await db()`UPDATE statuses SET label = ${label} WHERE id = ${id}`;
}

export async function setStatusArchived(id: number, archived: boolean): Promise<void> {
  await db()`UPDATE statuses SET archived = ${archived} WHERE id = ${id}`;
}

export async function setStatusRejet(id: number, isRejet: boolean): Promise<void> {
  await db()`UPDATE statuses SET is_rejet = ${isRejet} WHERE id = ${id}`;
}

// Échange de position avec le voisin (l'ordre d'affichage vit dans `position`).
export async function moveStatus(id: number, dir: "up" | "down"): Promise<void> {
  await db().begin(async (tx) => {
    const cur = await tx`SELECT position FROM statuses WHERE id = ${id}`;
    if (!cur[0]) return;
    const pos = cur[0].position;
    const neighbor =
      dir === "up"
        ? await tx`SELECT id, position FROM statuses WHERE position < ${pos} ORDER BY position DESC, id DESC LIMIT 1`
        : await tx`SELECT id, position FROM statuses WHERE position > ${pos} ORDER BY position ASC, id ASC LIMIT 1`;
    if (!neighbor[0]) return;
    await tx`UPDATE statuses SET position = ${neighbor[0].position} WHERE id = ${id}`;
    await tx`UPDATE statuses SET position = ${pos} WHERE id = ${neighbor[0].id}`;
  });
}

export async function addStatusEvent(idweb: string, statusId: number, userId: number): Promise<void> {
  await db()`INSERT INTO status_events (idweb, status_id, user_id) VALUES (${idweb}, ${statusId}, ${userId})`;
}

export type CurrentStatusEvent = {
  status_id: number;
  created_at: Date;
  user_id: number | null;
  author_name: string | null;
  author_email: string | null;
};

// Dernier événement de statut d'un avis, avec son auteur — null si aucun
// changement (l'avis est alors au statut par défaut, implicite).
export async function getCurrentStatusEvent(idweb: string): Promise<CurrentStatusEvent | null> {
  const rows = await db()`
    SELECT e.status_id, e.created_at, e.user_id, u.name AS author_name, u.email AS author_email
    FROM status_events e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.idweb = ${idweb}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    status_id: Number(r.status_id),
    created_at: r.created_at,
    user_id: r.user_id === null ? null : Number(r.user_id),
    author_name: r.author_name,
    author_email: r.author_email,
  };
}

// « Nouveau » pour l'email = apparu depuis le dernier digest réellement envoyé
// (et non depuis le run précédent : un run manuel — SKIP_DIGEST — ne doit pas
// faire disparaître ses trouvailles du digest du lendemain).
export async function getNewSinceLastDigest(runId: number, category: string): Promise<StoredAnnouncement[]> {
  const rows = await db()`
    SELECT * FROM announcements
    WHERE first_seen_run_id > (SELECT COALESCE(max(id), 0) FROM runs WHERE digest_sent)
      AND first_seen_run_id <= ${runId}
      AND category = ${category}
    ORDER BY deadline ASC NULLS LAST, idweb`;
  return rows as StoredAnnouncement[];
}

export async function markDigestSent(runId: number): Promise<void> {
  await db()`UPDATE runs SET digest_sent = true WHERE id = ${runId}`;
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

// --- Configuration de la veille (gérée dans /configuration) -----------------------
// Même philosophie que les statuts : lignes éditables par petites actions POST,
// lues par le job quotidien (src/run.ts) au démarrage de chaque run.

export type KeywordRow = { id: number; term: string; position: number };
export type ScopeRuleRow = { id: number; kind: "keep" | "exclude"; term: string };

export async function listKeywords(): Promise<KeywordRow[]> {
  const rows = await db()`SELECT id, term, position FROM search_keywords ORDER BY position, id`;
  return rows.map((r: { id: unknown; term: string; position: number }) => ({
    id: Number(r.id),
    term: r.term,
    position: r.position,
  }));
}

export async function addKeyword(term: string, userId: number): Promise<boolean> {
  const rows = await db()`
    INSERT INTO search_keywords (term, position, created_by)
    VALUES (${term}, (SELECT COALESCE(max(position), 0) + 10 FROM search_keywords), ${userId})
    ON CONFLICT (term) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

// Refuse de supprimer le dernier mot-clé : une liste vide reviendrait à
// récupérer tous les avis ouverts (le filtre ne porterait plus que sur la date).
export async function deleteKeyword(id: number): Promise<boolean> {
  const rows = await db()`
    DELETE FROM search_keywords
    WHERE id = ${id} AND (SELECT count(*) FROM search_keywords) > 1
    RETURNING id`;
  return rows.length > 0;
}

export async function listScopeRules(): Promise<ScopeRuleRow[]> {
  const rows = await db()`SELECT id, kind, term FROM scope_rules ORDER BY kind, term, id`;
  return rows.map((r: { id: unknown; kind: "keep" | "exclude"; term: string }) => ({
    id: Number(r.id),
    kind: r.kind,
    term: r.term,
  }));
}

export async function addScopeRule(
  kind: "keep" | "exclude",
  term: string,
  userId: number,
): Promise<boolean> {
  const rows = await db()`
    INSERT INTO scope_rules (kind, term, created_by)
    VALUES (${kind}, ${term}, ${userId})
    ON CONFLICT (kind, term) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function deleteScopeRule(id: number): Promise<void> {
  await db()`DELETE FROM scope_rules WHERE id = ${id}`;
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db()`SELECT value FROM settings WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

// value = null : retour à la valeur par défaut (la ligne est supprimée).
export async function setSetting(key: string, value: string | null, userId: number): Promise<void> {
  if (value === null) {
    await db()`DELETE FROM settings WHERE key = ${key}`;
  } else {
    await db()`
      INSERT INTO settings (key, value, updated_by)
      VALUES (${key}, ${value}, ${userId})
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()`;
  }
}
