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
}
