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
  // Pour resemer les mots-clés après un test qui les vide (le serveur ne migre
  // qu'au démarrage).
  Bun.env.POSTGRESQL_ADDON_URI = TEST_URL;
  const dbModule = await import("./db.ts");
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stderr = "";
  let cookie = "";

  const stats = {
    calls: 7, errors: 0, retries: 0, fallbacks: 0, promptTokens: 100, completionTokens: 20,
    costUsd: 0.0012, byModel: { "mistralai/mistral-nemo": 7 }, breakerTripped: false,
  };

  async function get(path: string): Promise<{ status: number; text: string; location: string | null }> {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
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
    // Le même appel d'offres que B1, paru sur Marchés Online : doublon rattaché à B1.
    await control`
      INSERT INTO announcements (idweb, url, objet, acheteur, department, deadline, deadline_text, category, source, famille, first_seen_run_id, last_seen_run_id, doublon_de, published_at)
      VALUES ('MO-B1', 'https://marchesonline/MO-B1', 'Plan de mobilité BOAMP.', 'VILLE', '75', '2030-12-31', '31/12/2030', 'relevant', 'marchesonline', 'mobilité', ${runId}, ${runId}, 'B1', '12/09/2026')`;

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
    expect(home.text).toContain('badge src">achatpublic.com');
    expect(home.text).toContain("Inondations — AMC");
    expect(home.text).toContain('value="achatpublic"');
    // Clic principal = fiche interne (avec retour) ; les publications en second, seuls liens sortants.
    expect(home.text).toContain('class="objet" href="/avis/B1?retour=%2F"');
    expect(home.text).toContain('href="https://boamp/B1" target="_blank"');
    expect(home.text).not.toContain('href="https://boamp/B1">Plan');
    // Doublon : une seule ligne, les deux plateformes en liens, badge « 2 publications ».
    expect(home.text).not.toContain('href="/avis/MO-B1');
    expect(home.text).toContain("Publié sur</span> <a class=\"lien-annonce\" href=\"https://boamp/B1\"");
    expect(home.text).toContain('href="https://marchesonline/MO-B1" target="_blank" rel="noopener" title="Ouvrir la publication sur Marchés Online (Le Moniteur) (12/09/2026)">Marchés Online (Le Moniteur) ↗</a>');
    expect(home.text).toContain('>2 publications</span>');
    expect(home.text).toContain("Avis pertinents (2)");
    expect((await get("/?source=marchesonline")).text).toContain("Plan de mobilité BOAMP");
    // Statut modifiable depuis la liste : option courante (statut par défaut) sélectionnée.
    expect(home.text).toContain('data-live="statut"');
    expect(home.text).toMatch(/<option value="\d+" data-color="#[0-9a-f]{6}" selected>à évaluer/);
    // Première visite : rien de « nouveau pour moi ».
    expect(home.text).not.toContain('class="badge">Nouveau');
    // Les onglets gardent les filtres.
    const tab = await get("/?source=achatpublic&q=PAPI");
    expect(tab.text).toContain('href="/?source=achatpublic&amp;q=PAPI&amp;cat=travaux"');

    const filtered = await get("/?source=achatpublic");
    expect(filtered.text).toContain("Étude PAPI achatpublic");
    expect(filtered.text).not.toContain("Plan de mobilité BOAMP");

    const fam = await get("/?famille=inondations");
    expect(fam.text).toContain("Étude PAPI achatpublic");
    expect(fam.text).not.toContain("Plan de mobilité BOAMP");

    const q = await get("/?q=papi");
    expect(q.text).toContain("Étude PAPI achatpublic");
    expect(q.text).not.toContain("Plan de mobilité BOAMP");
    expect(q.text).toContain('class="objet" href="/avis/CSL_1?retour=%2F%3Fq%3Dpapi"');

    expect((await get("/?tri=recents")).text).toContain('value="recents" selected');
    expect((await get("/?tri=x")).text).toContain('value="echeance" selected');
    expect((await get("/?nouveaux=1")).text).toContain("Première visite");
  });

  test("« Nouveau » = apparu depuis ma visite précédente", async () => {
    await control`UPDATE users SET dashboard_seen_at = now() - interval '2 hours', dashboard_prev_seen_at = NULL WHERE email = ${EMAIL}`;
    await control`UPDATE announcements SET first_seen_at = now() - interval '3 hours' WHERE idweb = 'B1'`;
    const home = await get("/"); // nouvelle visite : repère = il y a 2 h
    expect(home.text).toMatch(/CSL_1[\s\S]*?<span class="badge">Nouveau/);
    expect(home.text).not.toMatch(/B1[^\n]*\n[^\n]*Nouveau/);
    const nouveaux = await get("/?nouveaux=1");
    expect(nouveaux.text).toContain("Étude PAPI achatpublic");
    expect(nouveaux.text).not.toContain("Plan de mobilité BOAMP");
  });

  test("statut depuis la liste sans JavaScript : POST classique puis retour à la liste", async () => {
    const [s] = (await control`SELECT id FROM statuses WHERE label = 'répondu'`) as Array<{ id: string }>;
    const res = await post("/avis/B1/statut", { statut: s!.id, retour: "/?source=boamp" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?source=boamp");
    const ev = (await control`SELECT status_id FROM status_events WHERE idweb = 'B1' ORDER BY id DESC LIMIT 1`) as Array<{ status_id: string }>;
    expect(ev[0]!.status_id).toBe(s!.id);
    expect((await get("/")).text).toMatch(/<option value="\d+" data-color="#[0-9a-f]{6}" selected>répondu/);
    // Chemin de retour externe refusé.
    const bad = await post("/avis/B1/statut", { statut: s!.id, retour: "https://evil.example" });
    expect(bad.headers.get("location")).toBe("/");
    // Fiche : retour vers la liste filtrée, bouton annonce, ancre commentaires.
    const fiche = await get("/avis/B1?retour=%2F%3Fsource%3Dboamp");
    expect(fiche.text).toContain('<a href="/?source=boamp">← Retour aux avis</a>');
    expect(fiche.text).toContain("Annonce officielle ↗");
    expect(fiche.text).toContain('id="commentaires"');
    expect((await get("/avis/B1?retour=https%3A%2F%2Fevil")).text).toContain('<a href="/">← Retour aux avis</a>');
  });

  test("page configuration : onglet Résultats par défaut, onglet Moteur avec sources et LLM", async () => {
    const page = await get("/configuration");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("Service indisponible");
    expect(page.text).toContain('class="active">Résultats');
    expect(page.text).toContain("Mots-clés de recherche");
    expect(page.text).toContain("Règles de tri");
    expect(page.text).toContain("Périmètre géographique");
    expect(page.text).toContain("Email quotidien");
    expect(page.text).not.toContain("Sources de veille");
    expect(page.text).not.toContain("Relancer maintenant");
    // Onglet inconnu = Résultats.
    expect((await get("/configuration?onglet=x")).text).toContain('class="active">Résultats');

    const moteur = await get("/configuration?onglet=moteur");
    expect(moteur.status).toBe(200);
    expect(moteur.text).toContain('class="active">Moteur');
    expect(moteur.text).toContain("Sources de veille");
    expect(moteur.text).toContain("BOAMP");
    expect(moteur.text).toContain("Marchés Online");
    expect(moteur.text).toContain("coupée sur le serveur"); // ACHATPUBLIC=0
    expect(moteur.text).toContain("mistral-nemo ×7");
    expect(moteur.text).toContain("Relancer maintenant");
    expect(moteur.text).toContain("Classement");
    expect(moteur.text).not.toContain("Mots-clés de recherche");
  });

  test("mots-clés par liste : sections, ajout dans une famille, dernier terme protégé", async () => {
    const page = await get("/configuration");
    expect(page.text).toContain('id="carte-mots-cles-boamp"');
    expect(page.text).toContain('id="carte-mots-cles-marchesonline"');
    expect(page.text).toContain("Maximilien et Marchés publics d'Aquitaine");
    let res = await post("/configuration/mots-cles/ajouter", { liste: "mpe", famille: "inondations", terme: "crue" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/configuration?onglet=resultats#carte-mots-cles-mpe");
    const rows = (await control`SELECT liste, famille FROM search_keywords WHERE term = 'crue'`) as Array<{ liste: string; famille: string }>;
    expect(rows).toEqual([{ liste: "mpe", famille: "inondations" }]);
    // BOAMP n'a pas de famille ; liste inconnue refusée.
    expect((await post("/configuration/mots-cles/ajouter", { liste: "boamp", famille: "kiomda", terme: "crue" })).status).toBe(200);
    expect((await post("/configuration/mots-cles/ajouter", { liste: "afd", famille: "mobilité", terme: "crue" })).status).toBe(200);
    const crue = ((await control`SELECT id FROM search_keywords WHERE term = 'crue'`) as Array<{ id: string }>)[0]!;
    res = await post("/configuration/mots-cles/supprimer", { id: crue.id });
    expect(res.headers.get("location")).toBe("/configuration?onglet=resultats#carte-mots-cles-mpe");
    await control`DELETE FROM search_keywords WHERE liste = 'boamp' AND term <> 'mobilité'`;
    const last = ((await control`SELECT id FROM search_keywords WHERE liste = 'boamp'`) as Array<{ id: string }>)[0]!;
    res = await post("/configuration/mots-cles/supprimer", { id: last.id });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dernier terme");
    await control`TRUNCATE search_keywords RESTART IDENTITY`;
    await dbModule.migrate();
  });

  test("essai d'une règle de tri sur les avis en cours, compte par règle", async () => {
    let page = await get("/configuration/essai?kind=exclude&terme=PAPI");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Essai : toujours exclure « PAPI »");
    expect(page.text).toContain("<strong>1</strong> avis en cours contient ce terme");
    expect(page.text).toContain("<strong>1</strong> changerait de catégorie");
    expect(page.text).toContain("Étude PAPI achatpublic");
    expect(page.text).toContain("→ exclu");
    expect(page.text).toContain("Ajouter cette règle");
    // Terme absent : rien ; terme invalide : page de configuration avec erreur.
    expect((await get("/configuration/essai?kind=keep&terme=zzzz")).text).toContain("Aucun avis en cours ne contient ce terme");
    expect((await get("/configuration/essai?kind=keep&terme=x")).text).toContain("Terme trop court");
    // Une règle « garder » existante l'emporte : l'exclusion ne change plus rien.
    await post("/configuration/regles/ajouter", { kind: "keep", terme: "papi" });
    page = await get("/configuration/essai?kind=exclude&terme=PAPI");
    expect(page.text).toContain("<strong>0</strong> changerait");
    expect(page.text).toContain("inchangé");
    // La liste des règles porte le compte d'avis en cours.
    page = await get("/configuration");
    expect(page.text).toContain("1 avis en cours</a>");
    expect(page.text).toContain('formaction="/configuration/essai"');
    await control`DELETE FROM scope_rules`;
  });

  test("interrupteur d'une source : réglage en base, env prioritaire, BOAMP intouchable", async () => {
    let res = await post("/configuration/sources", { id: "afd", valeur: "0" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/configuration?onglet=moteur#carte-sources");
    expect((await control`SELECT value FROM settings WHERE key = 'source_afd'`) as unknown[]).toEqual([{ value: "0" }]);
    let page = await get("/configuration?onglet=moteur");
    expect(page.text).toContain(">réactiver<");
    expect(page.text).toContain(">désactivée<");
    res = await post("/configuration/sources", { id: "afd", valeur: "1" });
    expect(res.status).toBe(303);
    expect((await control`SELECT value FROM settings WHERE key = 'source_afd'`) as unknown[]).toEqual([]);
    page = await get("/configuration?onglet=moteur");
    expect(page.text).not.toContain(">réactiver<");
    // Coupée par ACHATPUBLIC=0 : pas d'interrupteur, requête refusée.
    expect(page.text).not.toContain('name="id" value="achatpublic"');
    expect((await post("/configuration/sources", { id: "achatpublic", valeur: "1" })).status).toBe(200);
    expect((await post("/configuration/sources", { id: "boamp", valeur: "0" })).status).toBe(200);
    expect((await post("/configuration/sources", { id: "x", valeur: "0" })).status).toBe(200);
    expect((await control`SELECT count(*)::int AS n FROM settings`) as unknown[]).toEqual([{ n: 0 }]);
  });

  test("pause et notes sur mots-clés et règles, journal des modifications", async () => {
    await control`TRUNCATE config_events RESTART IDENTITY`;
    const velo = ((await control`SELECT id FROM search_keywords WHERE liste = 'boamp' AND term = 'vélo'`) as Array<{ id: string }>)[0]!;
    let res = await post("/configuration/mots-cles/activer", { id: velo.id, valeur: "0" });
    expect(res.status).toBe(303);
    let page = await get("/configuration");
    expect(page.text).toContain('class="mot inactif"');
    expect(page.text).toContain("En pause : cliquer pour réactiver");
    // Dernier terme actif de la liste BOAMP : refus.
    await control`UPDATE search_keywords SET enabled = false WHERE liste = 'boamp' AND term <> 'mobilité'`;
    const mob = ((await control`SELECT id FROM search_keywords WHERE liste = 'boamp' AND term = 'mobilité'`) as Array<{ id: string }>)[0]!;
    res = await post("/configuration/mots-cles/activer", { id: mob.id, valeur: "0" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dernier terme actif");
    await control`UPDATE search_keywords SET enabled = true`;

    // Règle avec note, mise en pause : affichée barrée, ignorée par l'essai.
    res = await post("/configuration/regles/ajouter", { kind: "keep", terme: "papi", note: "études AMC voulues" });
    expect(res.status).toBe(303);
    const regle = ((await control`SELECT id FROM scope_rules WHERE term = 'papi'`) as Array<{ id: string }>)[0]!;
    page = await get("/configuration");
    expect(page.text).toContain("— études AMC voulues");
    expect(page.text).toContain(">mettre en pause<");
    res = await post("/configuration/regles/activer", { id: regle.id, valeur: "0" });
    expect(res.status).toBe(303);
    page = await get("/configuration");
    expect(page.text).toContain("(en pause)");
    expect(page.text).toContain(">réactiver<");
    page = await get("/configuration/essai?kind=exclude&terme=PAPI");
    expect(page.text).toContain("<strong>1</strong> changerait de catégorie"); // la règle « garder » en pause ne protège plus

    // Journal : les plus récentes d'abord, auteur et détail.
    page = await get("/configuration");
    expect(page.text).toContain("Journal des modifications");
    const journal = page.text.slice(page.text.indexOf('id="carte-journal"'));
    expect(journal.indexOf("Règle mise en pause : toujours garder « papi »")).toBeLessThan(journal.indexOf("Règle ajoutée : toujours garder « papi » — études AMC voulues"));
    expect(journal).toContain("Mot-clé mis en pause : « vélo » (BOAMP)");
    expect(journal).toContain("admin@example.org");
    await post("/configuration/reglages", { fenetre: "21" });
    await post("/configuration/sources", { id: "afd", valeur: "0" });
    page = await get("/configuration?onglet=moteur");
    expect(page.text).toContain("Fenêtre des échéances rappelées : 21 jours");
    expect(page.text).toContain("Source désactivée : AFD (dgMarket)");
    await control`DELETE FROM scope_rules`;
    await control`DELETE FROM settings`;
    await control`TRUNCATE config_events RESTART IDENTITY`;
  });

  test("réglages : chaque carte n'écrit que ses champs et revient sur son onglet", async () => {
    let res = await post("/configuration/reglages", { fenetre: "21" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/configuration?onglet=resultats#carte-email");
    res = await post("/configuration/reglages", { classifieur: "regex", modeles: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/configuration?onglet=moteur#carte-classement");
    const rows = (await control`SELECT key, value FROM settings ORDER BY key`) as Array<{ key: string; value: string }>;
    expect(rows).toEqual([
      { key: "classifier_mode", value: "regex" },
      { key: "digest_window_days", value: "21" },
    ]);
    // La carte Email ne touche pas au classifieur, et inversement.
    res = await post("/configuration/reglages", { fenetre: "" });
    expect(res.status).toBe(303);
    const after = (await control`SELECT key, value FROM settings ORDER BY key`) as Array<{ key: string; value: string }>;
    expect(after).toEqual([{ key: "classifier_mode", value: "regex" }]);
    expect((await post("/configuration/reglages", { fenetre: "999" })).status).toBe(200); // erreur, page re-rendue
    await control`DELETE FROM settings`;
  });

  test("run « running » sans verrou : clôturé en erreur, relance possible", async () => {
    await control`INSERT INTO runs (status) VALUES ('running')`;
    const page = await get("/configuration?onglet=moteur");
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
      // Onglet Résultats : renvoi vers Moteur, pas de suivi en direct.
      const res = await get("/configuration");
      expect(res.text).toContain("suivre la progression dans l'onglet Moteur");
      expect(res.text).not.toContain('id="cfg-maj"');
      const conf = await get("/configuration?onglet=moteur");
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
    const conf = await get("/configuration?onglet=moteur");
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
    // Doublon → fiche du principal, avec la liste des publications.
    const dbl = await get("/avis/MO-B1?retour=%2F%3Fq%3Dplan");
    expect(dbl.status).toBe(302);
    expect(dbl.location).toBe("/avis/B1?retour=%2F%3Fq%3Dplan");
    const principal = await get("/avis/B1");
    expect(principal.text).toContain("Publié sur 2 plateformes");
    expect(principal.text).toContain("Marchés Online (Le Moniteur) ↗");
    expect(principal.text).toContain("fiche de référence");
  });
}
