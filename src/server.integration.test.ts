// Test de fumée du serveur : le vrai processus (`bun src/server.ts`) sur une
// base Postgres jetable, connexion par code (imprimé sur stderr hors
// production), puis les pages qui ont déjà cassé en production : tableau de
// bord (filtres source / famille), page configuration (statistiques LLM du
// dernier run, run orphelin), fiche d'un avis, /sante.
//
//   TEST_DATABASE_URL=postgresql://<user>@localhost:5432/avis_test bun test server.integration
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";

const TEST_URL = Bun.env.TEST_DATABASE_URL;
const PORT = 18089;
const BASE = `http://localhost:${PORT}`;
const EMAIL = "admin@example.org";

if (!TEST_URL) {
  test.skip("server.integration — TEST_DATABASE_URL absent", () => {});
} else {
  const control = new SQL(TEST_URL);
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stderr = "";
  let cookie = "";

  const stats = {
    calls: 7, errors: 0, retries: 0, fallbacks: 0, promptTokens: 100, completionTokens: 20,
    costUsd: 0.0012, byModel: { "mistralai/mistral-nemo": 7 }, breakerTripped: false,
  };

  async function get(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
    return { status: res.status, text: await res.text() };
  }
  async function post(path: string, form: Record<string, string>): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
  }
  async function waitFor(cond: () => Promise<boolean> | boolean, ms: number, label: string): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await cond()) return;
      await Bun.sleep(100);
    }
    throw new Error(`timeout (${ms} ms) : ${label}`);
  }

  beforeAll(async () => {
    // Données : un run réussi avec statistiques LLM (la page configuration les
    // affiche), un run « running » sans processus (orphelin), deux avis.
    await control`TRUNCATE comments, status_events, announcements, runs, users, sessions, email_verification_codes RESTART IDENTITY CASCADE`;
    const [run] = (await control`
      INSERT INTO runs (status, finished_at, total_fetched, relevant_count, travaux_count, excluded_count, llm_stats)
      VALUES ('success', now(), 2, 2, 0, 0, ${JSON.stringify(stats)}::text::jsonb) RETURNING id`) as Array<{ id: string }>;
    const runId = Number(run!.id);
    await control`
      INSERT INTO announcements (idweb, url, objet, acheteur, department, deadline, deadline_text, category, source, famille, first_seen_run_id, last_seen_run_id)
      VALUES ('B1', 'https://boamp/B1', 'Plan de mobilité BOAMP', 'Ville', '75', '2030-12-31', '31/12/2030', 'relevant', 'boamp', 'mobilité', ${runId}, ${runId}),
             ('CSL_1', 'https://achatpublic/CSL_1', 'Étude PAPI achatpublic', 'Syndicat', '30', '2030-12-31', '31/12/2030', 'relevant', 'achatpublic', 'inondations', ${runId}, ${runId})`;

    proc = Bun.spawn(["bun", "src/server.ts"], {
      env: {
        ...Bun.env,
        POSTGRESQL_ADDON_URI: TEST_URL,
        PORT: String(PORT),
        DASHBOARD_URL: BASE,
        ADMIN_EMAILS: EMAIL,
        LIVE_COMMENTS: "0",
        ACHATPUBLIC: "0",
        MAILPACE_API_TOKEN: "",
        OPENROUTER_API_KEY: "",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    (async () => {
      const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value);
      }
    })();
    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/sante`)).ok;
      } catch {
        return false;
      }
    }, 20_000, "démarrage du serveur");
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await control.close();
  });

  test("/sante est public et reflète le dernier run", async () => {
    const { status, text } = await get("/sante");
    expect(status).toBe(200);
    expect(JSON.parse(text).status).toBe("ok");
  });

  test("les pages exigent une session", async () => {
    expect((await get("/")).status).toBe(302);
    expect((await get("/configuration")).status).toBe(302);
  });

  test("connexion par code imprimé sur stderr", async () => {
    expect((await post("/connexion/code", { email: EMAIL })).status).toBeLessThan(400);
    await waitFor(() => /login code for admin@example.org: \d{6}/.test(stderr), 5_000, "code de connexion");
    const code = stderr.match(/login code for admin@example.org: (\d{6})/)![1]!;
    const res = await post("/connexion/verifier", { email: EMAIL, code });
    expect(res.status).toBe(303);
    const set = res.headers.getSetCookie().find((c) => c.includes("session"));
    expect(set).toBeDefined();
    cookie = set!.split(";")[0]!;
  });

  test("tableau de bord : badges de source et filtres", async () => {
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("Plan de mobilité BOAMP");
    expect(home.text).toContain("Étude PAPI achatpublic");
    expect(home.text).toContain('badge src boamp">BOAMP');
    expect(home.text).toContain('badge src">achatpublic.com');
    expect(home.text).toContain("Inondations — AMC");
    expect(home.text).toContain('value="achatpublic"');

    const filtered = await get("/?source=achatpublic");
    expect(filtered.text).toContain("Étude PAPI achatpublic");
    expect(filtered.text).not.toContain("Plan de mobilité BOAMP");

    const fam = await get("/?famille=inondations");
    expect(fam.text).toContain("Étude PAPI achatpublic");
    expect(fam.text).not.toContain("Plan de mobilité BOAMP");
  });

  test("page configuration : sources et statistiques LLM du dernier run", async () => {
    const page = await get("/configuration");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("Service indisponible");
    expect(page.text).toContain("Sources de veille");
    expect(page.text).toContain("BOAMP");
    expect(page.text).toContain("Marchés Online");
    expect(page.text).toContain("désactivée"); // ACHATPUBLIC=0
    expect(page.text).toContain("mistral-nemo ×7");
    expect(page.text).toContain("Relancer maintenant");
  });

  test("run « running » sans verrou : clôturé en erreur, relance possible", async () => {
    await control`INSERT INTO runs (status) VALUES ('running')`;
    const page = await get("/configuration");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("Mise à jour en cours");
    expect(page.text).toContain("échouée le");
    expect(page.text).toContain("Relancer maintenant");
    const rows = (await control`SELECT status, error FROM runs ORDER BY id DESC LIMIT 1`) as Array<{ status: string; error: string }>;
    expect(rows[0]!.status).toBe("error");
    expect(rows[0]!.error).toContain("interrompu");

    // Tableau de bord : bannière d'échec, données du dernier run réussi toujours affichées.
    const home = await get("/");
    expect(home.text).toContain("La dernière mise à jour a échoué");
    expect(home.text).toContain("Plan de mobilité BOAMP");
  });

  test("run en cours (verrou tenu) : jalons sur la configuration, résumé sur le tableau de bord, /sante", async () => {
    const progress = {
      steps: [
        { id: "boamp", label: "BOAMP", status: "done", done: 38, total: 38, unit: "pages", startedAt: "2026-09-18T10:00:00Z", finishedAt: "2026-09-18T10:12:00Z" },
        { id: "achatpublic", label: "achatpublic.com", status: "skipped", detail: "désactivée" },
        { id: "afd", label: "AFD (dgMarket)", status: "failed", detail: "indisponible : 503" },
        { id: "maximilien", label: "Maximilien", status: "running", done: 8, total: 22, unit: "pages", startedAt: "2026-09-18T10:12:00Z" },
        { id: "classify", label: "Classement", status: "pending", unit: "avis" },
      ],
      // Battement récent : sans lui, le verrou tenu passerait pour un zombie.
      updatedAt: new Date().toISOString(),
    };
    await control`SELECT pg_advisory_lock(823741)`;
    try {
      await control`INSERT INTO runs (status, progress) VALUES ('running', ${JSON.stringify(progress)}::text::jsonb)`;
      const conf = await get("/configuration");
      expect(conf.status).toBe(200);
      expect(conf.text).toContain("Mise à jour en cours");
      expect(conf.text).toContain('role="progressbar"');
      expect(conf.text).toContain("8 / 22 pages");
      expect(conf.text).toContain("indisponible : 503");
      expect(conf.text).toContain("désactivée");
      expect(conf.text).toContain('content="15"');
      expect(conf.text).toContain('<button class="primary" disabled>Relancer maintenant</button>');

      const home = await get("/");
      expect(home.text).toContain("Mise à jour en cours — BOAMP terminé · AFD (dgMarket) en échec · Maximilien 8 / 22 pages · démarrée il y a");

      const sante = JSON.parse((await get("/sante")).text);
      expect(sante.lastRun.status).toBe("running");
      expect(sante.lastRun.progress.steps).toHaveLength(5);

      // Suivi en direct : la page embarque la config du script, le fragment
      // rendu par le serveur suit l'état, le flux répond 503 sans moteur Skip.
      expect(conf.text).toContain('id="cfg-maj"');
      expect(home.text).toContain('id="bandeau-maj"');
      const runId = sante.lastRun.id;
      const frag = JSON.parse((await get(`/mise-a-jour/${runId}/fragment`)).text);
      expect(frag.running).toBe(true);
      expect(frag.card).toContain("8 / 22 pages");
      expect(frag.card).toContain("Relancer maintenant");
      expect(frag.banner).toContain("Maximilien 8 / 22 pages");
      expect((await get(`/mise-a-jour/${runId}/flux`)).status).toBe(503);
      expect((await get("/mise-a-jour/abc/fragment")).status).toBe(404);
    } finally {
      await control`SELECT pg_advisory_unlock(823741)`;
    }
    // Verrou relâché : le fragment répond « terminé » (la page se recharge) et
    // la ligne est clôturée, comme avant.
    const lastId = JSON.parse((await get("/sante")).text).lastRun.id;
    expect(JSON.parse((await get(`/mise-a-jour/${lastId}/fragment`)).text).running).toBe(false);
    const conf = await get("/configuration");
    expect(conf.text).not.toContain("Mise à jour en cours");
    expect(conf.text).not.toContain('id="cfg-maj"');
    const rows = (await control`SELECT status FROM runs ORDER BY id DESC LIMIT 1`) as Array<{ status: string }>;
    expect(rows[0]!.status).toBe("error");
  });

  test("fiche d'un avis et avis inconnu", async () => {
    const page = await get("/avis/CSL_1");
    expect(page.status).toBe(200);
    expect(page.text).toContain("achatpublic.com");
    expect(page.text).toContain("Inondations — AMC");
    expect((await get("/avis/INCONNU")).status).toBe(404);
  });
}
