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
type DbComment = {
  id: string;
  idweb: string;
  user_id: string | null;
  body: string;
  created_at: string;
};

type DbUser = {
  id: string;
  email: string;
  name: string | null;
};

export type CommentView = {
  id: string;
  user_id: string | null;
  body: string;
  created_at: string;
  author_name: string | null;
  author_email: string | null;
};

type ResourceInputs = { threads: EagerCollection<string, CommentView[]> };

// Le SELECT de l'adaptateur n'a pas d'ORDER BY : le tri vit ici.
export function buildThread(
  rows: readonly DbComment[],
  userOf: (id: string) => DbUser | undefined,
): CommentView[] {
  const sorted = [...rows].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : Number(a.id) - Number(b.id),
  );
  return sorted.map((c) => {
    const u = c.user_id === null ? undefined : userOf(c.user_id);
    return {
      id: c.id,
      user_id: c.user_id,
      body: c.body,
      created_at: c.created_at,
      author_name: u?.name ?? null,
      author_email: u?.email ?? null,
    };
  });
}

// clé = idweb → valeur unique : le fil complet, trié et enrichi de l'auteur.
class ThreadBuilder implements Mapper<string, DbComment, string, CommentView[]> {
  constructor(private users: EagerCollection<string, DbUser>) {}

  mapEntry(idweb: string, rows: Values<DbComment>, _context: Context): Iterable<[string, CommentView[]]> {
    return [[idweb, buildThread(rows.toArray(), (id) => this.users.getArray(id)[0])]];
  }
}

class ThreadResource implements Resource<ResourceInputs> {
  private idweb: string;

  constructor(params: Json) {
    const idweb = (params as { idweb?: unknown } | null)?.idweb;
    if (typeof idweb !== "string" || idweb === "") throw new Error("ThreadResource : idweb requis");
    this.idweb = idweb;
  }

  instantiate(collections: ResourceInputs): EagerCollection<string, CommentView[]> {
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
      return { threads: comments.map(ThreadBuilder, users) };
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
    WHERE event_object_table IN ('comments', 'users') AND trigger_schema = 'public'
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
