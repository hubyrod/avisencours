// Tests d'intégration du moteur de commentaires en direct (Skip WASM + adaptateur
// Postgres patché). Ils exigent une base Postgres jetable :
//
//   TEST_DATABASE_URL=postgresql://<user>@localhost:5432/avis_test bun test live.integration
//
// Sans TEST_DATABASE_URL ils sont ignorés (CI reste pure logique). Deux niveaux :
//   1. l'adaptateur seul, sur une table jetable — vérifie le patch de reconnexion
//      (patches/@skip-adapter%2Fpostgres@*.patch) en tuant la connexion LISTEN ;
//   2. le moteur complet (startLive + commentStream) sur le vrai schéma — vérifie
//      que le graphe réactif et le flux SSE survivent à la même coupure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

const TEST_URL = Bun.env.TEST_DATABASE_URL;
const STREAM_PORT = 19080;
const CONTROL_PORT = 19081;
// Le patch relance la connexion avec un backoff (1 s au premier essai) puis
// resynchronise chaque abonnement ; la valeur couvre largement ce délai.
const RECONNECT_TIMEOUT = 15_000;

type Waiter<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Waiter<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout (${ms} ms) : ${label}`)), ms)),
  ]);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout (${ms} ms) : ${label}`);
}

async function terminateBackends(control: SQL, appName: string): Promise<number> {
  const rows = (await control`
    SELECT pg_terminate_backend(pid) AS ok
    FROM pg_stat_activity
    WHERE application_name = ${appName} AND pid <> pg_backend_pid()
  `) as Array<{ ok: boolean }>;
  return rows.filter((r) => r.ok).length;
}

async function waitForBackend(control: SQL, appName: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rows = (await control`
      SELECT 1 FROM pg_stat_activity WHERE application_name = ${appName}
    `) as unknown[];
    if (rows.length > 0) return;
    await Bun.sleep(100);
  }
  throw new Error(`aucune connexion ${appName} après ${ms} ms`);
}

// Lecteur SSE minimal : découpe le flux en événements {event, data}.
type SseEvent = { event: string; data: string };
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: SseEvent[] = [];
  const waiters: Array<Waiter<SseEvent>> = [];
  let closed = false;

  const push = (ev: SseEvent) => {
    const w = waiters.shift();
    if (w) w.resolve(ev);
    else queue.push(ev);
  };

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (block.startsWith(":")) continue; // battement de cœur
          if (Bun.env.DEBUG_SSE) console.log("[SSE]", event, data);
          push({ event, data });
        }
      }
    } catch {
      // flux interrompu par abort
    } finally {
      closed = true;
    }
  })();

  return {
    next(): Promise<SseEvent> {
      const ev = queue.shift();
      if (ev) return Promise.resolve(ev);
      if (closed) return Promise.reject(new Error("flux SSE fermé"));
      const w = deferred<SseEvent>();
      waiters.push(w);
      return w.promise;
    },
    // Attend un événement dont le fil (valeur unique de la clé) satisfait le prédicat.
    async waitForThread(pred: (thread: unknown[]) => boolean, ms: number, label: string): Promise<unknown[]> {
      const until = Date.now() + ms;
      for (;;) {
        const left = until - Date.now();
        if (left <= 0) throw new Error(`timeout (${ms} ms) : ${label}`);
        const ev = await withTimeout(this.next(), left, label);
        if (ev.event !== "init" && ev.event !== "update") continue;
        const entries = JSON.parse(ev.data) as Array<[string, unknown[][]]>;
        // Un `update` vide ou sans entrée = le fil est vide.
        const thread = entries[0]?.[1]?.[0] ?? [];
        if (pred(thread)) return thread;
      }
    },
  };
}

type Item = { kind: string; body?: string; author_email?: string | null; status_label?: string | null };
const hasComment = (body: string) => (t: unknown[]) =>
  (t as Item[]).some((i) => i.kind === "comment" && i.body === body);

describe.skipIf(!TEST_URL)("adaptateur Postgres (patch de reconnexion)", () => {
  const APP = "avis-live-test-adapter";
  const TABLE = "live_test_rows";
  const INSTANCE = "live_test_instance";
  let control: SQL;
  let service: import("@skip-adapter/postgres").PostgresExternalService;
  type Update = { entries: Array<[unknown, unknown[]]>; isInit: boolean };
  const updates: Update[] = [];
  const waiters: Array<{ pred: (u: Update) => boolean; w: Waiter<Update> }> = [];
  const onUpdate = (u: Update) => {
    updates.push(u);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(u)) waiters.splice(i, 1)[0]!.w.resolve(u);
    }
  };
  const waitUpdate = (pred: (u: Update) => boolean, label: string) => {
    const found = updates.find(pred);
    if (found) return Promise.resolve(found);
    const w = deferred<Update>();
    waiters.push({ pred, w });
    return withTimeout(w.promise, RECONNECT_TIMEOUT, label);
  };

  beforeAll(async () => {
    if (!TEST_URL) return;
    control = new SQL({ url: TEST_URL, max: 1 });
    await control.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await control.unsafe(`CREATE TABLE ${TABLE} (k text PRIMARY KEY, v text NOT NULL)`);
    await control.unsafe(`INSERT INTO ${TABLE} VALUES ('a', 'initial')`);

    const { PostgresExternalService } = await import("@skip-adapter/postgres");
    const u = new URL(TEST_URL);
    const config = {
      host: u.hostname,
      port: Number(u.port || 5432),
      database: u.pathname.slice(1),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      application_name: APP,
    };
    service = new PostgresExternalService(config);
    await service.subscribe(
      INSTANCE,
      TABLE,
      { key: { col: "k", type: "TEXT" } },
      {
        update: async (entries, isInit) => onUpdate({ entries: entries as Update["entries"], isInit }),
        error: (e) => {
          throw new Error(`adaptateur : ${JSON.stringify(e)}`);
        },
      },
    );
  });

  afterAll(async () => {
    if (!TEST_URL) return;
    service?.unsubscribe(INSTANCE);
    await service?.shutdown();
    await control?.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await control?.close();
  });

  test("synchro initiale puis notification sur INSERT", async () => {
    const init = await waitUpdate((u) => u.isInit, "synchro initiale");
    expect(init.entries).toEqual([["a", [{ k: "a", v: "initial" }]]]);

    await control.unsafe(`INSERT INTO ${TABLE} VALUES ('b', 'live')`);
    const up = await waitUpdate((u) => !u.isInit && u.entries.some(([k]) => k === "b"), "notification b");
    expect(up.entries).toEqual([["b", [{ k: "b", v: "live" }]]]);
  });

  test("connexion LISTEN tuée → reconnexion, resynchro, notifications à nouveau reçues", async () => {
    const before = updates.length;
    expect(await terminateBackends(control, APP)).toBe(1);

    // Le patch resynchronise l'abonnement (isInit = true) sur la nouvelle connexion.
    const resync = await waitUpdate((u) => u.isInit && updates.indexOf(u) >= before, "resynchro après coupure");
    expect(resync.entries.map(([k]) => k).sort()).toEqual(["a", "b"]);
    expect(service.isConnected()).toBe(true);

    // Le patch resynchronise AVANT de refaire LISTEN : une écriture dans cet
    // intervalle serait perdue. open_instances n'est repeuplé qu'après le LISTEN.
    await waitFor(() => service.getOpenInstances().has(INSTANCE), RECONNECT_TIMEOUT, "LISTEN rétabli");

    // Une seule fonction/trigger par instance (pas de doublon après resubscribe).
    const triggers = (await control`
      SELECT count(*)::int AS n FROM information_schema.triggers
      WHERE event_object_table = ${TABLE} AND trigger_name = ${INSTANCE}
    `) as Array<{ n: number }>;
    // Un trigger INSERT OR UPDATE OR DELETE apparaît trois fois dans information_schema.
    expect(triggers[0]!.n).toBe(3);

    await control.unsafe(`INSERT INTO ${TABLE} VALUES ('c', 'apres')`);
    const up = await waitUpdate((u) => !u.isInit && u.entries.some(([k]) => k === "c"), "notification c après reconnexion");
    expect(up.entries).toEqual([["c", [{ k: "c", v: "apres" }]]]);

    await control.unsafe(`UPDATE ${TABLE} SET v = 'modifie' WHERE k = 'a'`);
    const upd = await waitUpdate(
      (u) => !u.isInit && u.entries.some(([k, v]) => k === "a" && (v[0] as { v: string }).v === "modifie"),
      "notification UPDATE a",
    );
    expect(upd.entries).toEqual([["a", [{ k: "a", v: "modifie" }]]]);
  }, 30_000);

  test("une notification n'est pas reçue deux fois après reconnexion", async () => {
    await control.unsafe(`INSERT INTO ${TABLE} VALUES ('d', 'unique')`);
    await waitUpdate((u) => !u.isInit && u.entries.some(([k]) => k === "d"), "notification d");
    await Bun.sleep(300);
    const count = updates.filter((u) => !u.isInit && u.entries.some(([k]) => k === "d")).length;
    expect(count).toBe(1);
  });
});

describe.skipIf(!TEST_URL)("moteur Skip complet (startLive + flux SSE)", () => {
  const IDWEB = "TEST-LIVE-1";
  let control: SQL;
  let live: typeof import("./live.ts");
  let dbmod: typeof import("./db.ts");
  let userId: number;
  let statusId: number;
  let statusLabel: string;

  beforeAll(async () => {
    if (!TEST_URL) return;
    Bun.env.POSTGRESQL_ADDON_URI = TEST_URL;
    Bun.env.SKIP_STREAMING_PORT = String(STREAM_PORT);
    Bun.env.SKIP_CONTROL_PORT = String(CONTROL_PORT);
    Bun.env.LIVE_COMMENTS = "1";

    control = new SQL({ url: TEST_URL, max: 1 });
    dbmod = await import("./db.ts");
    await dbmod.migrate();
    // statuses aussi : migrate() la réensemence quand elle est vide, ce qui remet
    // le libellé sondé plus bas à sa valeur d'origine même après un échec.
    await control`TRUNCATE comments, status_events, announcements, users, statuses RESTART IDENTITY CASCADE`;
    await dbmod.migrate();
    const [u] = (await control`
      INSERT INTO users (email, name) VALUES ('ana@example.com', 'Ana') RETURNING id
    `) as Array<{ id: number }>;
    userId = Number(u!.id);
    await control`
      INSERT INTO announcements (idweb, url, objet, category)
      VALUES (${IDWEB}, 'https://example.com', 'Étude test', 'relevant')
    `;
    const statuses = await dbmod.listStatuses();
    statusId = statuses[0]!.id;
    statusLabel = statuses[0]!.label;

    live = await import("./live.ts");
    await live.startLive();
  }, 30_000);

  afterAll(async () => {
    if (!TEST_URL) return;
    await control?.close();
  });

  test("le moteur est prêt et la santé répond", async () => {
    expect(live.isLiveReady()).toBe(true);
    const res = await fetch(`http://localhost:${CONTROL_PORT}/healthz`);
    expect(res.ok).toBe(true);
  });

  test("init → commentaire → statut → coupure Postgres → commentaire toujours reçu", async () => {
    const abort = new AbortController();
    const res = await live.commentStream(
      new Request(`http://localhost/avis/${IDWEB}/commentaires/flux`, { signal: abort.signal }),
      IDWEB,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const sse = sseReader(res);

    const first = await withTimeout(sse.next(), 10_000, "événement init");
    expect(first.event).toBe("init");

    await dbmod.addComment(IDWEB, userId, "premier");
    const t1 = (await sse.waitForThread(hasComment("premier"), 10_000, "commentaire 'premier'")) as Item[];
    expect(t1.find((i) => i.body === "premier")?.author_email).toBe("ana@example.com");

    await dbmod.addStatusEvent(IDWEB, statusId, userId);
    const t2 = (await sse.waitForThread(
      (t) => (t as Item[]).some((i) => i.kind === "statut"),
      10_000,
      "événement de statut",
    )) as Item[];
    expect(t2.find((i) => i.kind === "statut")?.status_label).toBe(statusLabel);
    expect(t2.map((i) => i.kind)).toEqual(["comment", "statut"]);

    // Coupure : on tue la connexion LISTEN du moteur ; le patch doit la rouvrir.
    expect(await terminateBackends(control, live.LIVE_APP_NAME)).toBe(1);
    await waitForBackend(control, live.LIVE_APP_NAME, RECONNECT_TIMEOUT);

    // La connexion revient d'abord, puis le patch resynchronise et refait LISTEN
    // table par table (4 tables). Une écriture entre la resynchro d'une table et
    // son LISTEN est perdue — limite connue du patch, d'où l'attente ici.
    await waitFor(() => {
      const st = live.liveAdapterState();
      return st.connected && st.watched === 4;
    }, RECONNECT_TIMEOUT, "LISTEN rétablis sur les 4 tables");

    // Un renommage de statut (table jointe, pas la table du fil) se propage en direct.
    await control`UPDATE statuses SET label = ${statusLabel + " ✓"} WHERE id = ${statusId}`;
    await sse.waitForThread(
      (t) => (t as Item[]).some((i) => i.kind === "statut" && i.status_label === statusLabel + " ✓"),
      10_000,
      "renommage de statut après coupure",
    );

    await dbmod.addComment(IDWEB, userId, "après coupure");
    const t3 = (await sse.waitForThread(hasComment("après coupure"), RECONNECT_TIMEOUT, "commentaire après coupure")) as Item[];
    expect(t3.map((i) => i.kind === "comment" ? i.body : i.kind)).toEqual(["premier", "statut", "après coupure"]);

    // Suppression propagée aussi.
    await control`DELETE FROM comments WHERE body = 'premier'`;
    const t4 = (await sse.waitForThread((t) => !hasComment("premier")(t), 10_000, "suppression 'premier'")) as Item[];
    expect(t4.map((i) => i.kind === "comment" ? i.body : i.kind)).toEqual(["statut", "après coupure"]);

    abort.abort();
  }, 60_000);

  test("un second abonné sur le même avis reçoit l'état courant à l'init", async () => {
    const abort = new AbortController();
    const res = await live.commentStream(
      new Request(`http://localhost/avis/${IDWEB}/commentaires/flux`, { signal: abort.signal }),
      IDWEB,
    );
    const sse = sseReader(res);
    const t = (await sse.waitForThread(hasComment("après coupure"), 10_000, "init du second abonné")) as Item[];
    expect(t.length).toBe(2);
    abort.abort();
  });

  test("idweb sans fil → init vide", async () => {
    const abort = new AbortController();
    const res = await live.commentStream(
      new Request("http://localhost/avis/INCONNU/commentaires/flux", { signal: abort.signal }),
      "INCONNU",
    );
    const sse = sseReader(res);
    const first = await withTimeout(sse.next(), 10_000, "init vide");
    expect(first.event).toBe("init");
    expect(JSON.parse(first.data)).toEqual([]);
    abort.abort();
  });
});
