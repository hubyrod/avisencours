// Commentaires en direct : moteur réactif Skip (WASM, in-process) + flux SSE.
// Ce module est réservé au serveur web — run.ts (cron) ne doit JAMAIS l'importer,
// sinon le job ouvrirait une connexion LISTEN Postgres et chargerait le runtime WASM.
import { runService } from "@skipruntime/server";
import { PostgresExternalService } from "@skip-adapter/postgres";
import type {
  Context,
  EagerCollection,
  Json,
  Mapper,
  Resource,
  SkipService,
  Values,
} from "@skipruntime/core";
import { db } from "./db.ts";

const STREAM_PORT = Number(Bun.env.SKIP_STREAMING_PORT ?? 9080);
const CONTROL_PORT = Number(Bun.env.SKIP_CONTROL_PORT ?? 9081);
const ENABLED = Bun.env.LIVE_COMMENTS !== "0";

// L'adaptateur pg renvoie int8 et timestamptz sous forme de chaînes.
export type DbComment = {
  id: string;
  idweb: string;
  user_id: string | null;
  body: string;
  created_at: string;
};

export type DbUser = {
  id: string;
  email: string;
  name: string | null;
};

export type DbStatusEvent = {
  id: string;
  idweb: string;
  status_id: string;
  user_id: string | null;
  created_at: string;
};

export type DbStatus = {
  id: string;
  label: string;
  color: string;
};

// Le fil d'un avis interclasse commentaires et changements de statut. `merge`
// exige le même type de valeur des deux côtés : tout est chaîne ou null (Json).
export type ThreadItem =
  | {
      kind: "comment";
      id: string;
      user_id: string | null;
      body: string;
      created_at: string;
      author_name: string | null;
      author_email: string | null;
    }
  | {
      kind: "statut";
      id: string;
      user_id: string | null;
      created_at: string;
      author_name: string | null;
      author_email: string | null;
      status_id: string;
      status_label: string | null;
      status_color: string | null;
    };

type ResourceInputs = { threads: EagerCollection<string, ThreadItem[]> };

type UserOf = (id: string) => DbUser | undefined;

function author(user_id: string | null, userOf: UserOf) {
  const u = user_id === null ? undefined : userOf(user_id);
  return { author_name: u?.name ?? null, author_email: u?.email ?? null };
}

export function commentToItem(c: DbComment, userOf: UserOf): ThreadItem {
  return {
    kind: "comment",
    id: c.id,
    user_id: c.user_id,
    body: c.body,
    created_at: c.created_at,
    ...author(c.user_id, userOf),
  };
}

export function eventToItem(
  e: DbStatusEvent,
  userOf: UserOf,
  statusOf: (id: string) => DbStatus | undefined,
): ThreadItem {
  const s = statusOf(e.status_id);
  return {
    kind: "statut",
    id: e.id,
    user_id: e.user_id,
    created_at: e.created_at,
    ...author(e.user_id, userOf),
    status_id: e.status_id,
    status_label: s?.label ?? null,
    status_color: s?.color ?? null,
  };
}

// Le SELECT de l'adaptateur n'a pas d'ORDER BY : le tri vit ici. Les ids viennent
// de deux séquences distinctes — à date égale on départage d'abord par kind.
export function sortThread(items: readonly ThreadItem[]): ThreadItem[] {
  return [...items].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
}

// Chaque commentaire devient un ThreadItem enrichi de l'auteur (clé conservée : idweb).
class CommentItems implements Mapper<string, DbComment, string, ThreadItem> {
  constructor(private users: EagerCollection<string, DbUser>) {}

  mapEntry(idweb: string, rows: Values<DbComment>, _context: Context): Iterable<[string, ThreadItem]> {
    const userOf: UserOf = (id) => this.users.getArray(id)[0];
    return rows.toArray().map((c) => [idweb, commentToItem(c, userOf)] as [string, ThreadItem]);
  }
}

// Chaque événement de statut devient un ThreadItem (jointure users + statuses —
// statuses est suivie aussi : un renommage dans /admin se propage en direct).
class StatusEventItems implements Mapper<string, DbStatusEvent, string, ThreadItem> {
  constructor(
    private users: EagerCollection<string, DbUser>,
    private statuses: EagerCollection<string, DbStatus>,
  ) {}

  mapEntry(idweb: string, rows: Values<DbStatusEvent>, _context: Context): Iterable<[string, ThreadItem]> {
    const userOf: UserOf = (id) => this.users.getArray(id)[0];
    const statusOf = (id: string) => this.statuses.getArray(id)[0];
    return rows.toArray().map((e) => [idweb, eventToItem(e, userOf, statusOf)] as [string, ThreadItem]);
  }
}

// clé = idweb → valeur unique : le fil complet (commentaires + statuts), trié.
class ThreadSorter implements Mapper<string, ThreadItem, string, ThreadItem[]> {
  mapEntry(idweb: string, items: Values<ThreadItem>, _context: Context): Iterable<[string, ThreadItem[]]> {
    return [[idweb, sortThread(items.toArray())]];
  }
}

class ThreadResource implements Resource<ResourceInputs> {
  private idweb: string;

  constructor(params: Json) {
    const idweb = (params as { idweb?: unknown } | null)?.idweb;
    if (typeof idweb !== "string" || idweb === "") throw new Error("ThreadResource : idweb requis");
    this.idweb = idweb;
  }

  instantiate(collections: ResourceInputs): EagerCollection<string, ThreadItem[]> {
    return collections.threads.slice(this.idweb, this.idweb);
  }
}

function makeService(): SkipService<Record<string, never>, ResourceInputs> {
  const url = Bun.env.POSTGRESQL_ADDON_URI ?? Bun.env.DATABASE_URL;
  if (!url) throw new Error("POSTGRESQL_ADDON_URI is required");
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode");
  const postgres = new PostgresExternalService({
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ...(sslmode && sslmode !== "disable" ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  return {
    externalServices: { postgres },
    resources: { thread: ThreadResource },
    createGraph(_inputs, context) {
      // Clés déclarées TEXT même pour les bigint : la synchro initiale produit des
      // clés chaînes alors que le chemin NOTIFY produirait des nombres — les clés
      // numériques divergeraient à la première mise à jour.
      const comments = context.useExternalResource<string, DbComment>({
        service: "postgres",
        identifier: "comments",
        params: { key: { col: "idweb", type: "TEXT" } },
      });
      const users = context.useExternalResource<string, DbUser>({
        service: "postgres",
        identifier: "users",
        params: { key: { col: "id", type: "TEXT" } },
      });
      const statusEvents = context.useExternalResource<string, DbStatusEvent>({
        service: "postgres",
        identifier: "status_events",
        params: { key: { col: "idweb", type: "TEXT" } },
      });
      const statuses = context.useExternalResource<string, DbStatus>({
        service: "postgres",
        identifier: "statuses",
        params: { key: { col: "id", type: "TEXT" } },
      });
      const commentItems = comments.map(CommentItems, users);
      const eventItems = statusEvents.map(StatusEventItems, users, statuses);
      return { threads: commentItems.merge(eventItems).map(ThreadSorter) };
    },
  };
}

// L'adaptateur pose des triggers LISTEN/NOTIFY sur les tables suivies ; après un
// arrêt brutal ils s'accumulent — on purge les orphelins avant de redémarrer.
async function cleanupOrphanTriggers(): Promise<void> {
  const sql = db();
  const rows = (await sql`
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE event_object_table IN ('comments', 'users', 'status_events', 'statuses') AND trigger_schema = 'public'
  `) as Array<{ trigger_name: string; event_object_table: string }>;
  const seen = new Set<string>();
  for (const { trigger_name, event_object_table } of rows) {
    const key = `${trigger_name}:${event_object_table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await sql.unsafe(`DROP TRIGGER IF EXISTS "${trigger_name}" ON "${event_object_table}"`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${trigger_name}" CASCADE`);
    console.error(`live: trigger orphelin purgé — ${trigger_name} sur ${event_object_table}`);
  }
}

let liveReady = false;

export function isLiveReady(): boolean {
  return liveReady;
}

export async function startLive(): Promise<void> {
  if (!ENABLED) {
    console.error("live: commentaires en direct désactivés (LIVE_COMMENTS=0)");
    return;
  }
  await cleanupOrphanTriggers();
  await runService(makeService(), {
    streaming_port: STREAM_PORT,
    control_port: CONTROL_PORT,
    no_cors: true,
  });
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`http://localhost:${CONTROL_PORT}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        liveReady = true;
        console.error(`live: moteur Skip prêt (flux :${STREAM_PORT}, contrôle :${CONTROL_PORT})`);
        return;
      }
    } catch {
      // pas encore prêt
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`le moteur Skip ne répond pas sur le port ${CONTROL_PORT}`);
}

const HEARTBEAT = new TextEncoder().encode(":hb\n\n");
const unavailable = () => new Response("Flux indisponible", { status: 503 });

// Poignée de main en une seule route (même origine, cookie de session déjà vérifié
// par handle()) : création de l'UUID sur le port de contrôle, puis relais du flux
// SSE du port de streaming vers le client. À la déconnexion, DELETE de l'UUID —
// indispensable, sinon le graphe réactif de l'abonné fuit dans le runtime WASM.
export async function commentStream(req: Request, idweb: string): Promise<Response> {
  if (!liveReady) return unavailable();

  let uuid: string;
  try {
    const mint = await fetch(`http://localhost:${CONTROL_PORT}/v1/streams/thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idweb }),
      signal: AbortSignal.timeout(5000),
    });
    if (!mint.ok) return unavailable();
    uuid = (await mint.text()).trim();
  } catch {
    return unavailable();
  }
  const dropUuid = () =>
    fetch(`http://localhost:${CONTROL_PORT}/v1/streams/${uuid}`, { method: "DELETE" }).catch(() => {});

  const upstreamAbort = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(`http://localhost:${STREAM_PORT}/v1/streams/${uuid}`, {
      headers: { Accept: "text/event-stream" },
      signal: upstreamAbort.signal,
    });
  } catch {
    void dropUuid();
    return unavailable();
  }
  if (!upstream.ok || !upstream.body) {
    void dropUuid();
    return unavailable();
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Le LB de Clever Cloud coupe les connexions muettes (~60 s) : battement toutes les 25 s.
      const hb = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(HEARTBEAT);
          } catch {
            cleanup();
          }
        }
      }, 25_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        upstreamAbort.abort();
        void dropUuid();
        try {
          controller.close();
        } catch {
          // déjà fermé
        }
      };
      req.signal.addEventListener("abort", cleanup);
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!closed) controller.enqueue(value);
          }
        } catch {
          // flux amont interrompu
        } finally {
          cleanup();
        }
      })();
    },
    cancel() {
      upstreamAbort.abort();
      void dropUuid();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
