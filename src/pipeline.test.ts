// Pipeline sans réseau : faux portail BOAMP injecté, sources secondaires
// coupées par réglage, classifieur regex, cache dans un dossier temporaire.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runPipeline } from "./pipeline.ts";
import type { FetchLike } from "./http.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete Bun.env[name];
  else Bun.env[name] = value;
}
const saved = { url: Bun.env.PORTAL_API_URL, dataset: Bun.env.PORTAL_DATASET };
beforeAll(() => {
  Bun.env.PORTAL_API_URL = "https://portail.test/api/explore/v2.1/catalog/datasets";
  Bun.env.PORTAL_DATASET = "boamp";
});
afterAll(() => {
  restoreEnv("PORTAL_API_URL", saved.url);
  restoreEnv("PORTAL_DATASET", saved.dataset);
});

const SANS_SECONDAIRES = { source_achatpublic: "0", source_afd: "0", source_maximilien: "0", source_ampa: "0", source_marchesonline: "0" };
const cachePath = `${import.meta.dir}/../.cache/pipeline.test.json`;

const okPortal: FetchLike = async () =>
  new Response(JSON.stringify({ total_count: 1, results: [{ idweb: "B1", objet: "Plan de mobilité", url_avis: "https://boamp/B1", nature_libelle: "Avis de marché" }] }), { status: 200 });
const deadPortal: FetchLike = async () => new Response("down", { status: 500 });

describe("runPipeline", () => {
  test("portail joignable : avis classé, aucune source en échec", async () => {
    const r = await runPipeline({ classifier: "regex", settings: SANS_SECONDAIRES, fetchImpl: okPortal, cachePath, log: () => {} });
    expect(r.relevant.map((a) => a.idweb)).toEqual(["B1"]);
    expect(r.failedSources).toEqual([]);
    expect(r.warning).toBeUndefined();
  });
  test("BOAMP bloquant (défaut, CLI) : l'erreur remonte", async () => {
    await expect(
      runPipeline({ classifier: "regex", settings: SANS_SECONDAIRES, fetchImpl: deadPortal, cachePath, log: () => {}, maxPages: 1 }),
    ).rejects.toThrow("API 500");
  });
  test("BOAMP non bloquant (job quotidien) : avertissement nommant BOAMP, source en échec, run poursuivi", async () => {
    const r = await runPipeline({
      classifier: "regex", settings: SANS_SECONDAIRES, fetchImpl: deadPortal, cachePath, log: () => {}, maxPages: 1, boampBlocking: false,
    });
    expect(r.failedSources).toEqual(["boamp"]);
    expect(r.warning).toContain("BOAMP indisponible");
    expect(r.relevant).toEqual([]);
  });
});
