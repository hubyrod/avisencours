// Tests d'intégration de la couche base (schéma réel, Postgres jetable) :
//
//   TEST_DATABASE_URL=postgresql://<user>@localhost:5432/avis_test bun test db.integration
//
// En CI, un service Postgres fournit cette base (voir .github/workflows/ci.yml).
// Sans TEST_DATABASE_URL, le fichier est ignoré. Couvre ce que les tests purs
// ne voient pas : la forme réellement stockée (jsonb), la migration des
// anciennes lignes, le verrou et les runs orphelins, les filtres du tableau
// de bord.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

const TEST_URL = Bun.env.TEST_DATABASE_URL;

if (!TEST_URL) {
  test.skip("db.integration — TEST_DATABASE_URL absent", () => {});
} else {
  Bun.env.POSTGRESQL_ADDON_URI = TEST_URL;
  const db = await import("./db.ts");
  const control = new SQL(TEST_URL);

  const stats = {
    calls: 3, errors: 0, retries: 0, fallbacks: 0, promptTokens: 10, completionTokens: 2,
    costUsd: 0.001, byModel: { "mistralai/mistral-nemo": 3 }, breakerTripped: false,
  };

  const avis = (idweb: string, extra: Partial<Parameters<typeof db.upsertAnnouncements>[1][number]> = {}) => ({
    idweb, url: `https://x/${idweb}`, publishedAt: "1 septembre 2026", deadline: "31/12/2030 à 12h00",
    objet: `Objet ${idweb}`, department: "75", acheteur: "Ville", typeAvis: "Avis", procedure: "MAPA", raw: "",
    source: "boamp" as const, famille: "mobilité" as const, matchedQueries: [], category: "relevant" as const,
    ...extra,
  });

  beforeAll(async () => {
    await db.migrate();
    await control`TRUNCATE comments, status_events, announcements, runs, users RESTART IDENTITY CASCADE`;
  });
  afterAll(async () => {
    await control.close();
  });

  describe("runs.llm_stats", () => {
    test("finishRun stocke un objet jsonb, relu tel quel", async () => {
      const id = await db.startRun();
      await db.finishRun(id, { status: "success", totalFetched: 1, relevant: 1, travaux: 0, excluded: 0, llmStats: stats });
      const [row] = (await control`SELECT jsonb_typeof(llm_stats) AS t FROM runs WHERE id = ${id}`) as Array<{ t: string }>;
      expect(row!.t).toBe("object");
      expect((await db.getLastRun())?.llm_stats).toEqual(stats);
    });

    test("migrate déplie une ancienne ligne doublement sérialisée", async () => {
      const id = await db.startRun();
      await control`UPDATE runs SET status = 'success', finished_at = now(), llm_stats = to_jsonb(${JSON.stringify(stats)}::text) WHERE id = ${id}`;
      const [before] = (await control`SELECT jsonb_typeof(llm_stats) AS t FROM runs WHERE id = ${id}`) as Array<{ t: string }>;
      expect(before!.t).toBe("string");
      await db.migrate();
      const [after] = (await control`SELECT jsonb_typeof(llm_stats) AS t FROM runs WHERE id = ${id}`) as Array<{ t: string }>;
      expect(after!.t).toBe("object");
      expect((await db.getLastRun())?.llm_stats).toEqual(stats);
    });
  });

  describe("runs.progress", () => {
    test("updateRunProgress stocke un objet jsonb relu avec le run", async () => {
      const id = await db.startRun();
      const progress = {
        steps: [
          { id: "boamp", label: "BOAMP", status: "done" as const, done: 38, total: 38, unit: "pages" as const },
          { id: "classify", label: "Classement", status: "running" as const, done: 120, total: 3900, unit: "avis" as const },
        ],
        updatedAt: "2026-09-18T10:00:00.000Z",
      };
      await db.updateRunProgress(id, progress);
      const [row] = (await control`SELECT jsonb_typeof(progress) AS t FROM runs WHERE id = ${id}`) as Array<{ t: string }>;
      expect(row!.t).toBe("object");
      expect((await db.getLastRun())?.progress).toEqual(progress);
      await db.finishRun(id, { status: "success", totalFetched: 0, relevant: 0, travaux: 0, excluded: 0 });
      expect((await db.getLastRun())?.progress).toEqual(progress);
    });
  });

  describe("verrou et runs orphelins", () => {
    test("isRunLockHeld suit le verrou d'une autre session", async () => {
      expect(await db.isRunLockHeld()).toBe(false);
      await control`SELECT pg_advisory_lock(823741)`;
      try {
        expect(await db.isRunLockHeld()).toBe(true);
        expect(await db.tryAcquireRunLock()).toBe(false);
      } finally {
        await control`SELECT pg_advisory_unlock(823741)`;
      }
      expect(await db.isRunLockHeld()).toBe(false);
    });

    test("battement de cœur et session zombie tenant le verrou", async () => {
      const now = Date.now();
      const fresh = {
        id: 1, started_at: new Date(now - 3_600_000), finished_at: null, status: "running", error: null,
        total_fetched: null, relevant_count: null, travaux_count: null, excluded_count: null,
        progress: { steps: [], updatedAt: new Date(now - 60_000).toISOString() },
      };
      expect(db.heartbeatStale(fresh, now)).toBe(false);
      expect(db.heartbeatStale({ ...fresh, progress: { steps: [], updatedAt: new Date(now - 11 * 60_000).toISOString() } }, now)).toBe(true);
      expect(db.heartbeatStale({ ...fresh, progress: null }, now)).toBe(true); // repli : started_at, il y a 1 h
      expect(db.heartbeatStale({ ...fresh, progress: null, started_at: new Date(now - 60_000) }, now)).toBe(false);

      // Une troisième connexion joue le processus mort qui garde le verrou.
      const zombie = new SQL(TEST_URL);
      await zombie`SELECT pg_advisory_lock(823741)`;
      expect(await db.isRunLockHeld()).toBe(true);
      expect(await db.terminateRunLockHolders()).toBe(1);
      expect(await db.isRunLockHeld()).toBe(false);
      expect(await db.tryAcquireRunLock()).toBe(true);
      await zombie.close().catch(() => {});
    });

    test("startRun clôt les lignes « running » abandonnées", async () => {
      await control`INSERT INTO runs (status) VALUES ('running')`;
      const id = await db.startRun();
      const rows = (await control`SELECT id, status, error FROM runs WHERE id >= ${id - 1} ORDER BY id`) as Array<{
        id: string; status: string; error: string | null;
      }>;
      expect(rows.map((r) => r.status)).toEqual(["error", "running"]);
      expect(rows[0]!.error).toContain("interrompu");
      expect(await db.closeOrphanRuns()).toBe(1);
    });
  });

  describe("markDashboardVisit", () => {
    test("repère de visite précédente stable pendant une visite, avancé après une heure", async () => {
      const [u] = (await control`INSERT INTO users (email) VALUES ('visite@example.org') RETURNING id`) as Array<{ id: string }>;
      const id = Number(u!.id);
      expect(await db.markDashboardVisit(id)).toBeNull(); // première visite
      expect(await db.markDashboardVisit(id)).toBeNull(); // même visite
      await control`UPDATE users SET dashboard_seen_at = now() - interval '2 hours' WHERE id = ${id}`;
      const prev = await db.markDashboardVisit(id); // nouvelle visite : repère = fin de la précédente
      expect(prev).not.toBeNull();
      expect(Date.now() - prev!.getTime()).toBeGreaterThan(3_600_000);
      const again = await db.markDashboardVisit(id); // même visite : inchangé
      expect(again!.getTime()).toBe(prev!.getTime());
    });
  });

  describe("doublons : même appel d'offres sur plusieurs plateformes", () => {
    test("regroupement, affichage unique, comptes, email, stabilité", async () => {
      await control`TRUNCATE comments, status_events, announcements RESTART IDENTITY CASCADE`;
      const run = await db.startRun();
      // Échéance dans 30 jours : « en cours » (non passée) et dans la fenêtre de rappel du digest.
      const d = new Date(Date.now() + 30 * 86_400_000);
      const jour = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      const objet = "Réalisation de prestations d'acquisitions de données (comptages et enquêtes) et réalisation de prestations d'études de circulation et de stationnement";
      await db.upsertAnnouncements(run, [
        avis("26-A", { objet, acheteur: "GRAND ANNECY", department: "74", deadline: `${jour} à 10h00`, publishedAt: "10 septembre 2026" }),
        avis("MO-A", { objet: objet + ".", acheteur: "Grand Annecy", department: "74", deadline: jour, source: "marchesonline", publishedAt: "12/09/2026" }),
        avis("MO-B", { objet: "Fourniture de vélos", acheteur: "Grand Annecy", department: "74", deadline: jour, source: "marchesonline" }),
      ]);
      await control`UPDATE announcements SET first_seen_at = now() - interval '2 days' WHERE idweb = '26-A'`;
      expect(await db.regrouperDoublons(run)).toEqual({ groupes: 1, doublons: 1 });
      expect((await db.getAnnouncement("MO-A"))?.doublon_de).toBe("26-A");
      expect((await db.getAnnouncement("26-A"))?.doublon_de).toBeNull();
      expect((await db.getAnnouncement("MO-B"))?.doublon_de).toBeNull();

      const current = await db.getCurrent("relevant", run);
      expect(current.map((a) => a.idweb).sort()).toEqual(["26-A", "MO-B"]);
      const grp = current.find((a) => a.idweb === "26-A")!;
      expect(grp.publications?.map((p) => `${p.source}:${p.idweb}`)).toEqual(["boamp:26-A", "marchesonline:MO-A"]);
      // Filtre source : le groupe est trouvé par l'une ou l'autre plateforme ; recherche dans un doublon.
      expect((await db.getCurrent("relevant", run, { source: "marchesonline" })).map((a) => a.idweb).sort()).toEqual(["26-A", "MO-B"]);
      expect((await db.getCurrent("relevant", run, { source: "boamp" })).map((a) => a.idweb)).toEqual(["26-A"]);
      expect((await db.getCurrent("relevant", run, { q: "stationnement." })).map((a) => a.idweb)).toEqual(["26-A"]);
      const counts = await db.countCurrentBySource(run);
      expect(counts.find((c) => c.source === "boamp")?.count).toBe(1);
      expect(counts.find((c) => c.source === "marchesonline")?.count).toBe(2);
      expect(await db.countByCategory(run)).toEqual({ relevant: 2 });
      expect((await db.getNewSinceLastDigest(run, "relevant")).map((a) => a.idweb).sort()).toEqual(["26-A", "MO-B"]);
      expect((await db.getUpcomingDeadlines(run, 60)).map((a) => a.idweb).sort()).toEqual(["26-A", "MO-B"]);
      const pubs = await db.loadPublications(["26-A", "MO-B"]);
      expect(pubs.get("26-A")?.length).toBe(2);
      expect(pubs.get("MO-B")?.length).toBe(1);

      // Run suivant : le principal reste, un doublon disparu est détaché, un
      // second run ne réinitialise pas doublon_de.
      const run2 = await db.startRun();
      await db.upsertAnnouncements(run2, [
        avis("26-A", { objet, acheteur: "GRAND ANNECY", department: "74", deadline: `${jour} à 10h00` }),
        avis("MO-A", { objet: objet + ".", acheteur: "Grand Annecy", department: "74", deadline: jour, source: "marchesonline" }),
      ]);
      expect((await db.getAnnouncement("MO-A"))?.doublon_de).toBe("26-A");
      await db.regrouperDoublons(run2);
      expect((await db.getAnnouncement("MO-A"))?.doublon_de).toBe("26-A");
      const run3 = await db.startRun();
      await db.upsertAnnouncements(run3, [avis("MO-A", { objet: objet + ".", acheteur: "Grand Annecy", department: "74", deadline: jour, source: "marchesonline" })]);
      await db.regrouperDoublons(run3);
      expect((await db.getAnnouncement("MO-A"))?.doublon_de).toBeNull();
      await control`TRUNCATE comments, status_events, announcements RESTART IDENTITY CASCADE`;
    });
  });

  describe("announcements : filtres du tableau de bord", () => {
    test("upsert, sources, familles, comptes par source", async () => {
      const run = await db.startRun();
      await db.upsertAnnouncements(run, [
        avis("B1"),
        avis("B2", { category: "travaux" }),
        avis("CSL_1", { source: "achatpublic" }),
        avis("CSL_2", { source: "achatpublic", famille: "inondations" }),
        avis("MO-1", { source: "marchesonline", category: "excluded" }),
        avis("OLD", { deadline: "01/01/2020" }),
      ]);
      await db.finishRun(run, { status: "success", totalFetched: 6, relevant: 4, travaux: 1, excluded: 1 });

      const all = await db.getCurrent("relevant", run);
      expect(all.map((a) => a.idweb).sort()).toEqual(["B1", "CSL_1", "CSL_2"]);
      expect((await db.getCurrent("relevant", run, { source: "achatpublic" })).map((a) => a.idweb).sort()).toEqual(["CSL_1", "CSL_2"]);
      expect((await db.getCurrent("relevant", run, { famille: "inondations" })).map((a) => a.idweb)).toEqual(["CSL_2"]);
      expect((await db.getCurrent("relevant", run, { source: "afd" })).length).toBe(0);

      const counts = await db.countCurrentBySource(run);
      const n = (s: string, c: string) => counts.find((x) => x.source === s && x.category === c)?.count ?? 0;
      expect(n("boamp", "relevant")).toBe(1);
      expect(n("boamp", "travaux")).toBe(1);
      expect(n("achatpublic", "relevant")).toBe(2);
      expect(n("marchesonline", "excluded")).toBe(1);

      // Recherche texte, tri, « nouveaux depuis ».
      expect((await db.getCurrent("relevant", run, { q: "csl_1" })).map((a) => a.idweb)).toEqual(["CSL_1"]);
      expect((await db.getCurrent("relevant", run, { q: "Ville" })).map((a) => a.idweb).sort()).toEqual(["B1", "CSL_1", "CSL_2"]);
      expect((await db.getCurrent("relevant", run, { q: "%" })).length).toBe(0);
      expect((await db.getCurrent("relevant", run, { newSince: new Date(Date.now() + 60_000) })).length).toBe(0);
      expect((await db.getCurrent("relevant", run, { newSince: new Date(Date.now() - 60_000) })).length).toBe(3);
      await control`UPDATE announcements SET first_seen_at = now() - interval '2 days' WHERE idweb = 'B1'`;
      expect((await db.getCurrent("relevant", run, { sort: "recents" })).map((a) => a.idweb).slice(-1)).toEqual(["B1"]);
      expect((await db.getCurrent("relevant", run, { sort: "echeance" }))[0]!.idweb).toBe("B1");

      // Un second run conserve first_seen et met à jour le reste.
      const run2 = await db.startRun();
      await db.upsertAnnouncements(run2, [avis("B1", { objet: "Objet B1 modifié", source: "maximilien" })]);
      const b1 = await db.getAnnouncement("B1");
      expect(b1?.objet).toBe("Objet B1 modifié");
      expect(b1?.source).toBe("maximilien");
      expect(Number(b1?.first_seen_run_id)).toBe(run);
      expect((await db.getCurrent("relevant", run2)).map((a) => a.idweb)).toEqual(["B1"]);
    });
  });
  describe("mémoire du run précédent", () => {
    test("llm_key stockée, verdicts LLM relus, jamais les verdicts regex / règle / erreur", async () => {
      const run = await db.startRun();
      await db.upsertAnnouncements(run, [
        avis("M1", { classifier: "mistralai/mistral-nemo", llmKey: "k1", reason: "plan" }),
        avis("M2", { classifier: "regex", llmKey: undefined }),
        avis("M3", { classifier: "regle", llmKey: "k3" }),
        avis("M4", { classifier: "erreur", llmKey: "k4" }),
        avis("M5", { classifier: "mistralai/mistral-nemo", llmKey: "k5", category: "excluded", reason: null as unknown as undefined }),
      ]);
      const memo = await db.loadLlmMemo();
      expect(memo.get("M1")).toEqual({ llmKey: "k1", category: "relevant", reason: "plan", classifier: "mistralai/mistral-nemo" });
      expect(memo.get("M5")).toEqual({ llmKey: "k5", category: "excluded", reason: null, classifier: "mistralai/mistral-nemo" });
      expect(memo.has("M2")).toBe(false);
      expect(memo.has("M3")).toBe(false);
      expect(memo.has("M4")).toBe(false);
      // Un run suivant qui classe par regex efface la clé (pas de verdict LLM à reprendre).
      const run2 = await db.startRun();
      await db.upsertAnnouncements(run2, [avis("M1", { classifier: "regex" })]);
      expect((await db.loadLlmMemo()).has("M1")).toBe(false);
    });

    test("avis connus des sources secondaires, datés du dernier run qui les a vus", async () => {
      const run = await db.startRun();
      await db.upsertAnnouncements(run, [
        avis("K-BOAMP"),
        avis("MO-K1", { source: "marchesonline", raw: "texte complet", deadline: "09/10/2026" }),
        avis("AMPA-K2", { source: "ampa", publishedAt: "" }),
      ]);
      const known = await db.loadKnownAnnouncements();
      expect(known("K-BOAMP")).toBeUndefined();
      const k1 = known("MO-K1")!;
      expect(k1).toMatchObject({ idweb: "MO-K1", source: "marchesonline", famille: "mobilité", raw: "texte complet", deadline: "09/10/2026", objet: "Objet MO-K1" });
      expect(k1.lastSeenAt).toBeInstanceOf(Date);
      expect(Math.abs(k1.lastSeenAt!.getTime() - Date.now())).toBeLessThan(60_000);
      expect(known("AMPA-K2")?.publishedAt).toBe("");
    });

    test("un lot de plus d'une tranche et un idweb répété passent en un upsert", async () => {
      const run = await db.startRun();
      const many = Array.from({ length: 1203 }, (_, i) => avis(`LOT-${i}`));
      await db.upsertAnnouncements(run, [...many, avis("LOT-0", { objet: "dernier gagne" })]);
      expect((await db.countByCategory(run)).relevant).toBe(1203);
      expect((await db.getAnnouncement("LOT-0"))?.objet).toBe("dernier gagne");
    });

    test("mots-clés : une liste par moteur, semée si absente, dernier terme d'une liste protégé", async () => {
      await control`TRUNCATE search_keywords RESTART IDENTITY`;
      await db.migrate();
      const parListe = (await control`SELECT liste, count(*)::int AS n FROM search_keywords GROUP BY liste ORDER BY liste`) as Array<{ liste: string; n: number }>;
      expect(parListe.map((r) => r.liste)).toEqual(["achatpublic", "boamp", "marchesonline", "mpe"]);
      expect(parListe.find((r) => r.liste === "boamp")?.n).toBe(14);
      // Les familles non mobilité sont semées avec leur famille.
      const kiomda = (await db.listKeywords()).filter((k) => k.liste === "marchesonline" && k.famille === "kiomda");
      expect(kiomda.map((k) => k.term)).toContain("compteur");

      // Une liste gardée par l'administrateur n'est pas resemée ; une liste absente l'est.
      await control`DELETE FROM search_keywords WHERE liste = 'mpe'`;
      await control`DELETE FROM search_keywords WHERE liste = 'achatpublic' AND NOT (term = 'vélo' AND famille = 'mobilité')`;
      await db.migrate();
      expect((await db.listKeywords()).filter((k) => k.liste === "achatpublic").map((k) => k.term)).toEqual(["vélo"]);
      expect((await db.listKeywords()).filter((k) => k.liste === "mpe").length).toBeGreaterThan(10);

      // Dernier terme d'une liste : refusé, même si d'autres listes sont pleines.
      const velo = (await db.listKeywords()).find((k) => k.liste === "achatpublic")!;
      expect(await db.deleteKeyword(velo.id)).toBe(false);
      // Même terme dans deux familles ou deux listes : autorisé ; doublon exact : refusé.
      expect(await db.addKeyword("vélo", 1, "achatpublic", "kiomda")).toBe(true);
      expect(await db.addKeyword("vélo", 1, "achatpublic", "kiomda")).toBe(false);
      const velo2 = (await db.listKeywords()).find((k) => k.liste === "achatpublic" && k.famille === "kiomda")!;
      expect(await db.deleteKeyword(velo2.id)).toBe(true);
      await control`TRUNCATE search_keywords RESTART IDENTITY`;
      await db.migrate();
    });

    test("essai d'une règle : préfiltre SQL sans accents ni casse, comptes par terme", async () => {
      await control`TRUNCATE comments, status_events, announcements RESTART IDENTITY CASCADE`;
      const run = await db.startRun();
      await db.upsertAnnouncements(run, [
        avis("R1", { objet: "Étude de MAÎTRISE D'ŒUVRE", raw: "" }),
        avis("R2", { objet: "Plan vélo", raw: "Descriptif : déploiement de fibre optique", category: "relevant" }),
        avis("R3", { objet: "Fibre optique passée", raw: "", deadline: "01/01/2020 à 12h00" }),
        avis("R4", { objet: "Doublon fibre optique", raw: "" }),
      ]);
      await control`UPDATE announcements SET doublon_de = 'R2' WHERE idweb = 'R4'`;
      await db.finishRun(run, { status: "success", totalFetched: 4, relevant: 3, travaux: 0, excluded: 0 });
      const fibre = await db.findCurrentMatching(run, "fibre optique");
      expect(fibre.map((a) => a.idweb)).toEqual(["R2"]); // R3 échue, R4 doublon
      expect((await db.findCurrentMatching(run, "maitrise d'oeuvre")).map((a) => a.idweb)).toEqual(["R1"]);
      expect((await db.findCurrentMatching(run, "100%")).length).toBe(0);
      const counts = await db.countCurrentMatching(run, ["fibre optique", "maitrise d'oeuvre", "absent"]);
      expect([...counts.entries()]).toEqual([["fibre optique", 1], ["maitrise d'oeuvre", 1], ["absent", 0]]);
      expect((await db.countCurrentMatching(run, [])).size).toBe(0);
      await control`TRUNCATE comments, status_events, announcements, runs RESTART IDENTITY CASCADE`;
    });

    test("pause d'un terme : jamais le dernier actif d'une liste ; journal qui survit à l'auteur", async () => {
      await control`TRUNCATE search_keywords RESTART IDENTITY`;
      await db.migrate();
      const boamp = (await db.listKeywords()).filter((k) => k.liste === "boamp");
      for (const k of boamp.slice(1)) expect(await db.setKeywordEnabled(k.id, false)).toBe(true);
      expect(await db.setKeywordEnabled(boamp[0]!.id, false)).toBe(false);
      expect(await db.deleteKeyword(boamp[0]!.id)).toBe(false); // les autres sont en pause
      expect(await db.deleteKeyword(boamp[1]!.id)).toBe(true); // un terme en pause se supprime
      expect(await db.setKeywordEnabled(boamp[2]!.id, true)).toBe(true);
      expect(await db.setKeywordEnabled(boamp[0]!.id, false)).toBe(true);
      expect((await db.listKeywords()).filter((k) => k.liste === "boamp" && k.enabled).map((k) => k.id)).toEqual([boamp[2]!.id]);
      // Note à la création, relue.
      expect(await db.addKeyword("crue", 1, "mpe", "inondations", "demandé par la direction")).toBe(true);
      expect((await db.listKeywords()).find((k) => k.term === "crue")?.note).toBe("demandé par la direction");

      await control`TRUNCATE config_events RESTART IDENTITY`;
      const [u] = (await control`INSERT INTO users (email) VALUES ('ephemere@example.org') RETURNING id`) as Array<{ id: string }>;
      const user = { id: Number(u!.id), email: "ephemere@example.org" };
      await db.logConfigEvent(user, "regle", "ajout", "Règle ajoutée : toujours exclure « fibre »");
      await db.logConfigEvent(user, "mot-cle", "pause", "Mot-clé mis en pause : « vélo » (BOAMP)");
      let events = await db.listConfigEvents(1);
      expect(events.map((e) => e.detail)).toEqual(["Mot-clé mis en pause : « vélo » (BOAMP)"]);
      await control`DELETE FROM users WHERE id = ${user.id}`;
      events = await db.listConfigEvents();
      expect(events.length).toBe(2);
      expect(events[1]?.user_email).toBe("ephemere@example.org");
      expect(events[1]?.user_name).toBeNull();
      await control`TRUNCATE search_keywords, config_events RESTART IDENTITY`;
      await db.migrate();
    });

    test("index sur last_seen_run_id et first_seen_run_id", async () => {
      const idx = (await control`SELECT indexname FROM pg_indexes WHERE tablename = 'announcements'`) as Array<{ indexname: string }>;
      const names = idx.map((i) => i.indexname);
      expect(names).toContain("announcements_last_seen_run");
      expect(names).toContain("announcements_first_seen_run");
    });
  });
}
