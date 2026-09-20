import { describe, expect, test } from "bun:test";
import { scrapeAll } from "./scraper.ts";
import type { FetchLike } from "./http.ts";

// L'URL du portail est construite depuis l'environnement (params.ts) : en CI
// il n'y a pas de .env, et le faux fetch ignore l'URL de toute façon.
Bun.env.PORTAL_API_URL ??= "https://portail.test";
Bun.env.PORTAL_DATASET ??= "boamp";

const params = { query: "mobilité", codeDepartement: [] as string[] };

function record(i: number) {
  return { idweb: `B${i}`, objet: `Objet ${i}`, url_avis: `https://boamp/${i}`, nature_libelle: "Avis de marché" };
}

// Faux portail : `total` enregistrements, `rows` par page ; échecs injectables par index de départ.
function fakeOds(total: number, opts: { failOnce?: Set<number> } = {}) {
  const calls: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const failed = new Set<number>();
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url);
    const start = Number(u.searchParams.get("offset") ?? "0");
    const rows = Number(u.searchParams.get("limit") ?? "100");
    calls.push(start);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (opts.failOnce?.has(start) && !failed.has(start)) {
      failed.add(start);
      return new Response("boom", { status: 503 });
    }
    const results = Array.from({ length: Math.max(0, Math.min(rows, total - start)) }, (_, i) => record(start + i));
    return Response.json({ total_count: total, results });
  };
  return { fetchImpl, calls, peak: () => peak };
}

describe("scrapeAll", () => {
  test("première page seule, puis pages suivantes en parallèle, ordre conservé", async () => {
    const ods = fakeOds(250);
    const pages: number[] = [];
    const items = await scrapeAll(params, { pageSize: 100, fetchImpl: ods.fetchImpl, sleep: async () => {}, onPage: (n, _b, t) => pages.push(n * 10 + t) });
    expect(items.map((it) => it.idweb)).toEqual(Array.from({ length: 250 }, (_, i) => `B${i}`));
    expect(ods.calls).toEqual([0, 100, 200]);
    expect(ods.peak()).toBe(2);
    expect(pages).toEqual([13, 23, 33]);
  });
  test("maxPages plafonne, une seule page quand tout tient dedans", async () => {
    const ods = fakeOds(1000);
    expect((await scrapeAll(params, { pageSize: 100, maxPages: 2, fetchImpl: ods.fetchImpl })).length).toBe(200);
    expect(ods.calls).toEqual([0, 100]);
    const small = fakeOds(30);
    expect((await scrapeAll(params, { pageSize: 100, fetchImpl: small.fetchImpl })).length).toBe(30);
    expect(small.calls).toEqual([0]);
    const empty = fakeOds(0);
    expect(await scrapeAll(params, { fetchImpl: empty.fetchImpl })).toEqual([]);
  });
  test("503 sur une page : réessayée, le run ne tombe pas", async () => {
    const ods = fakeOds(150, { failOnce: new Set([100]) });
    const items = await scrapeAll(params, { pageSize: 100, fetchImpl: ods.fetchImpl, sleep: async () => {} });
    expect(items.length).toBe(150);
    expect(ods.calls).toEqual([0, 100, 100]);
  });
  test("erreur persistante : remontée avec le statut", async () => {
    const fetchImpl: FetchLike = async () => new Response("down", { status: 500 });
    await expect(scrapeAll(params, { fetchImpl, sleep: async () => {} })).rejects.toThrow("API 500");
  });
});
