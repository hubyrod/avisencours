import { SQL } from "bun";
import { normalizeProgress, type RunProgress } from "./progress.ts";
import { deadlineDay, grouperDoublons, type Publication } from "./doublons.ts";
import type { ClassifiedItem } from "./pipeline.ts";
import { KEYWORDS } from "./defaults.ts";
import type { LlmStats } from "./llm.ts";

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
  // Repères de visite du tableau de bord (« Nouveau » = apparu depuis la visite précédente).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_seen_at timestamptz`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_prev_seen_at timestamptz`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS digest_sent boolean NOT NULL DEFAULT false`;
  // Classification via OpenRouter : coût/usage du run, avertissement non
  // bloquant (coupe-circuit, clé absente), et qui a classé chaque avis.
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS llm_stats jsonb`;
  // Les runs écrits avant le 18/09/2026 ont un jsonb « chaîne » (le JSON était
  // lui-même sérialisé une seconde fois par le pilote) : on le déplie une fois.
  await sql`UPDATE runs SET llm_stats = (llm_stats #>> '{}')::jsonb WHERE jsonb_typeof(llm_stats) = 'string'`;
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS warning text`;
  // Progression du run en cours (src/progress.ts), écrite par le job au fil des étapes.
  await sql`ALTER TABLE runs ADD COLUMN IF NOT EXISTS progress jsonb`;
  await sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS classifier text`;
  // Sources secondaires (achatpublic.com) et familles de veille (src/familles.ts).
  await sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'boamp'`;
  await sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS famille text NOT NULL DEFAULT 'mobilité'`;
  // Doublons : même appel d'offres publié sur plusieurs plateformes (src/doublons.ts).
  // NULL = principal (affiché, compté, porte statut et commentaires) ; sinon idweb du principal.
  await sql`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS doublon_de text REFERENCES announcements(idweb) ON DELETE SET NULL`;
  await sql`CREATE INDEX IF NOT EXISTS announcements_doublon_de ON announcements (doublon_de)`;
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

// Le verrou consultatif est tenu par la session Postgres du run tant que son
// processus vit : c'est le signe de vie fiable d'une mise à jour (un run tué
// par un redéploiement le relâche aussitôt). Clé bigint : classid = 32 bits
// hauts (0 ici), objid = 32 bits bas, objsubid = 1.
export async function isRunLockHeld(): Promise<boolean> {
  const rows = await db()`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND classid = ${Math.floor(RUN_LOCK_ID / 2 ** 32)} AND objid = ${RUN_LOCK_ID % 2 ** 32} AND objsubid = 1`;
  return Number(rows[0]?.n ?? 0) > 0;
}

// Un processus tué net (instance arrêtée par un redéploiement) laisse sa
// session Postgres — et le verrou — en vie jusqu'à ce que le serveur détecte
// la coupure TCP, parfois plus d'une demi-heure (vu le 18/09/2026 : run 68
// tué à 17:29, verrou encore visible à 17:52). Le verrou seul ne suffit donc
// pas : le job bat aussi le cœur dans runs.progress.updatedAt (au moins toutes
// les deux secondes en activité). Sans battement depuis HEARTBEAT_STALE_MS, la
// session qui tient le verrou est un zombie : on la termine pour libérer le
// verrou, sinon le run suivant ne pourrait pas démarrer.
export const HEARTBEAT_STALE_MS = 10 * 60_000;

export function lastHeartbeat(run: RunRow): number {
  const beat = run.progress?.updatedAt ? new Date(run.progress.updatedAt).getTime() : NaN;
  return Number.isFinite(beat) ? beat : new Date(run.started_at).getTime();
}

export function heartbeatStale(run: RunRow, now: number = Date.now()): boolean {
  return now - lastHeartbeat(run) > HEARTBEAT_STALE_MS;
}

export async function terminateRunLockHolders(): Promise<number> {
  const rows = await db()`
    SELECT pg_terminate_backend(l.pid) AS ok FROM pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted
      AND l.classid = ${Math.floor(RUN_LOCK_ID / 2 ** 32)} AND l.objid = ${RUN_LOCK_ID % 2 ** 32} AND l.objsubid = 1
      AND l.pid <> pg_backend_pid()`;
  const n = (rows as Array<{ ok: boolean }>).filter((r) => r.ok).length;
  // pg_terminate_backend est asynchrone : le verrou tombe quand la session
  // s'arrête, quelques millisecondes plus tard. On attend (2 s max) pour que
  // l'appelant puisse reprendre le verrou tout de suite.
  for (let i = 0; n > 0 && i < 40 && (await isRunLockHeld()); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return n;
}

// Ligne(s) « running » sans processus derrière — mise à jour manuelle tuée par
// un redéploiement, instance arrêtée… — clôturée(s) en erreur. Sans danger
// tant que le verrou n'est pas tenu (ou que l'appelant le tient lui-même).
export async function closeOrphanRuns(): Promise<number> {
  const rows = await db()`
    UPDATE runs SET status = 'error', finished_at = now(),
      error = 'interrompu : le processus de mise à jour a été arrêté avant la fin (redéploiement ou arrêt de l''instance)'
    WHERE status = 'running' RETURNING id`;
  return rows.length;
}

// Appelé sous le verrou (tryAcquireRunLock) : toute ligne encore « running »
// appartient donc à un processus mort.
export async function startRun(): Promise<number> {
  await closeOrphanRuns();
  const rows = await db()`INSERT INTO runs DEFAULT VALUES RETURNING id`;
  return Number(rows[0].id);
}

// Écrit l'état d'avancement (jalons + compteurs). Ne doit jamais faire
// échouer un run : l'appelant ignore les erreurs.
export async function updateRunProgress(id: number, progress: RunProgress): Promise<void> {
  await db()`UPDATE runs SET progress = ${JSON.stringify(progress)}::text::jsonb WHERE id = ${id}`;
}

export async function finishRun(
  id: number,
  outcome:
    | {
        status: "success";
        totalFetched: number;
        relevant: number;
        travaux: number;
        excluded: number;
        llmStats?: LlmStats | null;
        warning?: string | null;
      }
    | { status: "error"; error: string },
): Promise<void> {
  if (outcome.status === "success") {
    await db()`
      UPDATE runs SET finished_at = now(), status = 'success',
        total_fetched = ${outcome.totalFetched},
        relevant_count = ${outcome.relevant},
        travaux_count = ${outcome.travaux},
        excluded_count = ${outcome.excluded},
        llm_stats = ${outcome.llmStats ? JSON.stringify(outcome.llmStats) : null}::text::jsonb,
        warning = ${outcome.warning?.slice(0, 2000) ?? null}
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
          published_at, deadline, deadline_text, category, reason, classifier, raw,
          source, famille, first_seen_run_id, last_seen_run_id
        ) VALUES (
          ${it.idweb}, ${it.url}, ${it.objet}, ${it.acheteur}, ${it.department},
          ${it.typeAvis}, ${it.procedure}, ${it.publishedAt},
          ${parseDeadlineText(it.deadline)}, ${it.deadline},
          ${it.category}, ${it.reason ?? null}, ${it.classifier ?? null}, ${it.raw},
          ${it.source}, ${it.famille}, ${runId}, ${runId}
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
          classifier = EXCLUDED.classifier,
          raw = EXCLUDED.raw,
          source = EXCLUDED.source,
          famille = EXCLUDED.famille,
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
  classifier?: string | null;
  source?: string | null;
  famille?: string | null;
  first_seen_run_id: number | null;
  first_seen_at?: Date;
  doublon_de?: string | null;
  // Principal + doublons (getCurrent) : toutes les plateformes où l'appel est paru.
  publications?: PublicationLien[];
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

export type PublicationLien = { idweb: string; source: string; url: string; published_at: string | null };

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
  digest_sent?: boolean;
  llm_stats?: LlmStats | null;
  warning?: string | null;
  progress?: RunProgress | null;
};

// llm_stats peut revenir en chaîne JSON (colonne jsonb de type « string »,
// écrite par une version antérieure) : on la déplie, et on ignore ce qui n'a
// pas la forme attendue plutôt que de faire tomber la page.
export function normalizeLlmStats(v: unknown): LlmStats | null {
  let s: unknown = v;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<LlmStats>;
  if (typeof o.calls !== "number") return null;
  return { ...o, byModel: o.byModel && typeof o.byModel === "object" ? o.byModel : {} } as LlmStats;
}

function toRunRow(row: Record<string, unknown> | undefined): RunRow | null {
  if (!row) return null;
  return { ...(row as RunRow), llm_stats: normalizeLlmStats(row.llm_stats), progress: normalizeProgress(row.progress) };
}

export async function getLastRun(): Promise<RunRow | null> {
  const rows = await db()`SELECT * FROM runs ORDER BY id DESC LIMIT 1`;
  return toRunRow(rows[0] as Record<string, unknown> | undefined);
}

export async function getRun(id: number): Promise<RunRow | null> {
  const rows = await db()`SELECT * FROM runs WHERE id = ${id}`;
  return toRunRow(rows[0] as Record<string, unknown> | undefined);
}

export async function getLastSuccessfulRun(): Promise<RunRow | null> {
  const rows = await db()`SELECT * FROM runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`;
  return toRunRow(rows[0] as Record<string, unknown> | undefined);
}

// Visite du tableau de bord : `dashboard_seen_at` = dernier affichage,
// `dashboard_prev_seen_at` = fin de la visite précédente (une visite = des
// affichages espacés de moins d'une heure). Renvoie le repère « précédent »,
// stable pendant toute la visite courante, contre lequel « Nouveau » se calcule.
export async function markDashboardVisit(userId: number): Promise<Date | null> {
  const rows = await db()`
    UPDATE users SET
      dashboard_prev_seen_at = CASE
        WHEN dashboard_seen_at IS NULL OR dashboard_seen_at < now() - interval '1 hour' THEN dashboard_seen_at
        ELSE dashboard_prev_seen_at END,
      dashboard_seen_at = now()
    WHERE id = ${userId}
    RETURNING dashboard_prev_seen_at`;
  const v = (rows[0] as { dashboard_prev_seen_at: Date | null } | undefined)?.dashboard_prev_seen_at ?? null;
  return v ? new Date(v) : null;
}

export type CurrentSort = "echeance" | "recents" | "nouveaute";

export type CurrentFilter = {
  statusId?: number | null;
  hideRejet?: boolean;
  famille?: string | null;
  source?: string | null;
  // Recherche texte sur l'objet et l'acheteur (ILIKE, sensible aux accents).
  q?: string | null;
  // Ne garder que les avis apparus après cette date (« nouveaux pour moi »).
  newSince?: Date | null;
  sort?: CurrentSort;
};

// Announcements still present in the latest successful run, deadline not passed
// (or unknown). Statut courant = dernier événement ; aucun événement = statut
// par défaut (premier statut actif par position), d'où le COALESCE — le filtre
// « à évaluer » doit aussi attraper les avis sans événement. Le tri se fait en
// mémoire (quelques milliers de lignes au plus) : échéance croissante par défaut,
// ou avis vus le plus récemment en premier.
export async function getCurrent(
  category: string,
  runId: number,
  filter?: CurrentFilter,
): Promise<StoredAnnouncement[]> {
  const statusId = filter?.statusId ?? null;
  const hideRejet = filter?.hideRejet ?? false;
  const famille = filter?.famille ?? null;
  const source = filter?.source ?? null;
  const q = filter?.q?.trim() ? `%${filter.q.trim().replace(/[%_\\]/g, "\\$&")}%` : null;
  const newSince = filter?.newSince ?? null;
  const defaultId = (await getDefaultStatus())?.id ?? null;
  // Seuls les principaux sont listés ; `pubs` = principal + doublons (toutes les
  // plateformes), pour l'affichage, le filtre source et la recherche.
  const rows = await db()`
    SELECT a.*,
      (SELECT count(*)::int FROM comments c WHERE c.idweb = a.idweb) AS comment_count,
      s.id AS status_id, s.label AS status_label, s.color AS status_color, s.is_rejet AS status_is_rejet,
      cur.created_at AS status_set_at, cur.user_id AS status_set_by_id,
      su.name AS status_set_by_name, su.email AS status_set_by_email,
      pubs.publications
    FROM announcements a
    LEFT JOIN LATERAL (
      SELECT e.status_id, e.created_at, e.user_id FROM status_events e
      WHERE e.idweb = a.idweb
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) cur ON true
    LEFT JOIN statuses s ON s.id = COALESCE(cur.status_id, ${defaultId})
    LEFT JOIN users su ON su.id = cur.user_id
    JOIN LATERAL (
      SELECT json_agg(json_build_object('idweb', p.idweb, 'source', p.source, 'url', p.url, 'published_at', p.published_at)
                      ORDER BY (p.idweb = a.idweb) DESC, p.first_seen_at, p.idweb) AS publications,
             bool_or(${source}::text IS NOT NULL AND p.source = ${source}) AS sur_source,
             bool_or(${q}::text IS NOT NULL AND (p.objet ILIKE ${q} OR COALESCE(p.acheteur, '') ILIKE ${q})) AS cherche
      FROM announcements p
      WHERE p.idweb = a.idweb OR p.doublon_de = a.idweb
    ) pubs ON true
    WHERE a.last_seen_run_id = ${runId}
      AND a.doublon_de IS NULL
      AND a.category = ${category}
      AND (a.deadline IS NULL OR a.deadline >= now())
      AND (${statusId}::bigint IS NULL OR COALESCE(cur.status_id, ${defaultId}) = ${statusId})
      AND (${hideRejet} = false OR COALESCE(s.is_rejet, false) = false)
      AND (${famille}::text IS NULL OR a.famille = ${famille})
      AND (${source}::text IS NULL OR pubs.sur_source)
      AND (${q}::text IS NULL OR pubs.cherche)
      AND (${newSince}::timestamptz IS NULL OR a.first_seen_at > ${newSince})
    ORDER BY a.deadline ASC NULLS LAST, a.idweb`;
  const items = (rows as Array<StoredAnnouncement & { publications: unknown }>).map((r) => ({
    ...r,
    publications: normalizePublications(r.publications),
  })) as StoredAnnouncement[];
  const sort = filter?.sort ?? "echeance";
  if (sort === "recents" || sort === "nouveaute") {
    items.sort((x, y) => {
      const dx = x.first_seen_at ? new Date(x.first_seen_at).getTime() : 0;
      const dy = y.first_seen_at ? new Date(y.first_seen_at).getTime() : 0;
      if (dx !== dy) return dy - dx;
      const ex = x.deadline ? new Date(x.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      const ey = y.deadline ? new Date(y.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      return ex - ey || x.idweb.localeCompare(y.idweb);
    });
  }
  return items;
}

// Avis « en cours » (même définition que getCurrent, sans filtre) comptés par
// source et catégorie — pour le filtre du tableau de bord et la page
// configuration.
export type SourceCount = { source: string; category: string; count: number };

function normalizePublications(v: unknown): PublicationLien[] {
  const arr = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? (arr as PublicationLien[]) : [];
}

// Appels d'offres (principaux) en cours ayant une publication sur la source :
// un appel BOAMP + Marchés Online compte pour chacune des deux, une fois.
export async function countCurrentBySource(runId: number): Promise<SourceCount[]> {
  const rows = await db()`
    SELECT p.source, a.category, count(DISTINCT a.idweb)::int AS count
    FROM announcements a
    JOIN announcements p ON p.idweb = a.idweb OR p.doublon_de = a.idweb
    WHERE a.last_seen_run_id = ${runId}
      AND a.doublon_de IS NULL
      AND (a.deadline IS NULL OR a.deadline >= now())
    GROUP BY p.source, a.category`;
  return rows as SourceCount[];
}

// Publications (principal + doublons) d'une liste de principaux, en une requête
// — pour l'email et la fiche, qui ne passent pas par getCurrent.
export async function loadPublications(idwebs: string[]): Promise<Map<string, PublicationLien[]>> {
  const out = new Map<string, PublicationLien[]>();
  if (idwebs.length === 0) return out;
  const rows = (await db()`
    SELECT COALESCE(p.doublon_de, p.idweb) AS principal, p.idweb, p.source, p.url, p.published_at, p.first_seen_at
    FROM announcements p
    WHERE p.idweb IN (SELECT jsonb_array_elements_text(${JSON.stringify(idwebs)}::text::jsonb))
       OR p.doublon_de IN (SELECT jsonb_array_elements_text(${JSON.stringify(idwebs)}::text::jsonb))
    ORDER BY (p.doublon_de IS NULL) DESC, p.first_seen_at, p.idweb`) as Array<PublicationLien & { principal: string }>;
  for (const r of rows) {
    if (!out.has(r.principal)) out.set(r.principal, []);
    out.get(r.principal)!.push({ idweb: r.idweb, source: r.source, url: r.url, published_at: r.published_at });
  }
  return out;
}

export async function attachPublications(items: StoredAnnouncement[]): Promise<StoredAnnouncement[]> {
  const pubs = await loadPublications(items.map((a) => a.idweb));
  return items.map((a) => ({ ...a, publications: pubs.get(a.idweb) ?? [{ idweb: a.idweb, source: a.source ?? "boamp", url: a.url, published_at: a.published_at }] }));
}

// Comptes par catégorie du run, en appels d'offres (principaux) — pour
// runs.relevant_count & co, après regroupement des doublons.
export async function countByCategory(runId: number): Promise<Record<string, number>> {
  const rows = (await db()`
    SELECT category, count(*)::int AS count FROM announcements
    WHERE last_seen_run_id = ${runId} AND doublon_de IS NULL
    GROUP BY category`) as Array<{ category: string; count: number }>;
  return Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
}

// Regroupe les doublons parmi les avis du run (src/doublons.ts) et écrit
// announcements.doublon_de. Réexamine tout le run : un principal désigné
// reste principal, les nouvelles publications se rattachent, les groupes qui
// se défont (avis disparu) sont défaits.
export async function regrouperDoublons(runId: number): Promise<{ groupes: number; doublons: number }> {
  const sql = db();
  const rows = (await sql`
    SELECT a.idweb, a.objet, a.acheteur, a.department, a.deadline, a.deadline_text, a.source, a.first_seen_at, a.doublon_de,
      (SELECT count(*)::int FROM comments c WHERE c.idweb = a.idweb)
      + (SELECT count(*)::int FROM status_events e WHERE e.idweb = a.idweb) AS activite
    FROM announcements a
    WHERE a.last_seen_run_id = ${runId}`) as Array<{
    idweb: string; objet: string; acheteur: string | null; department: string | null; deadline: Date | null;
    deadline_text: string | null; source: string; first_seen_at: Date; doublon_de: string | null; activite: number;
  }>;
  const pubs: Publication[] = rows.map((r) => ({
    idweb: r.idweb,
    objet: r.objet,
    acheteur: r.acheteur,
    department: r.department,
    deadlineDay: deadlineDay(r.deadline_text) ?? deadlineDay(r.deadline),
    source: r.source,
    firstSeenAt: new Date(r.first_seen_at),
    doublonDe: r.doublon_de,
    activite: Number(r.activite),
  }));
  const groupes = grouperDoublons(pubs);
  const principalDe = new Map<string, string>();
  for (const g of groupes) for (const d of g.doublons) principalDe.set(d, g.principal);
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const cible = principalDe.get(r.idweb) ?? null;
      if ((r.doublon_de ?? null) !== cible) await tx`UPDATE announcements SET doublon_de = ${cible} WHERE idweb = ${r.idweb}`;
    }
  });
  return { groupes: groupes.length, doublons: principalDe.size };
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
      AND doublon_de IS NULL
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
      AND doublon_de IS NULL
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
