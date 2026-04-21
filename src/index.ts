import { buildDefaultParams, DEFAULT_QUERY } from "./defaults.ts";
import { scrapeAll, type Announcement } from "./scraper.ts";
import { renderMarkdown, type Matched } from "./report.ts";
import { classify, type Classification } from "./classify.ts";
import { classifyLLM } from "./classify-llm.ts";
import { classifyHybrid } from "./classify-hybrid.ts";

const EXCLUDE_TYPE_AVIS = [/attribution/i, /résultat/i, /annulation/i];

function keep(a: Announcement): boolean {
  return !EXCLUDE_TYPE_AVIS.some((re) => re.test(a.typeAvis));
}

type CachedItem = Announcement & { matchedQueries: string[] };

async function loadOrScrape(cachePath: string, useCache: boolean): Promise<CachedItem[]> {
  if (useCache) {
    const f = Bun.file(cachePath);
    if (await f.exists()) {
      console.error(`loading cache: ${cachePath}`);
      return (await f.json()) as CachedItem[];
    }
  }

  const query = Bun.argv.slice(2).join(" ").trim() || DEFAULT_QUERY;
  const maxPages = Bun.env.MAX_PAGES ? Number(Bun.env.MAX_PAGES) : 100;
  const params = buildDefaultParams(query);

  console.error(`query: ${query.length > 120 ? query.slice(0, 120) + "…" : query}`);

  const items = await scrapeAll(params, {
    maxPages,
    pageSize: 100,
    onPage: (n, batch) => console.error(`  page ${n}: ${batch.length} items`),
  });

  const byId = new Map<string, CachedItem>();
  for (const it of items.filter(keep)) {
    const key = it.idweb || it.url;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, { ...it, matchedQueries: [query] });
  }

  const arr = [...byId.values()];
  await Bun.write(cachePath, JSON.stringify(arr, null, 2));
  console.error(`cached ${arr.length} unique avis -> ${cachePath}`);
  return arr;
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (t: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main() {
  const useCache = Bun.env.USE_CACHE === "1";
  const cachePath = ".cache/scrape.json";
  const items = await loadOrScrape(cachePath, useCache);

  const requested = Bun.env.CLASSIFIER ?? "hybrid";
  if (requested !== "regex" && requested !== "llm" && requested !== "hybrid") {
    throw new Error(`Invalid CLASSIFIER="${requested}" (expected: regex | llm | hybrid)`);
  }
  const needsKey = requested === "hybrid" || requested === "llm";
  const mode: "regex" | "llm" | "hybrid" =
    needsKey && !Bun.env.MISTRAL_API_KEY
      ? (console.error(`MISTRAL_API_KEY not set — falling back from ${requested} to regex`), "regex")
      : requested;
  console.error(`classifier: ${mode}`);

  const classifyOne =
    mode === "regex"
      ? async (it: Announcement): Promise<Classification> => classify(it)
      : async (it: Announcement): Promise<Classification> => {
          try {
            return mode === "hybrid" ? await classifyHybrid(it) : await classifyLLM(it);
          } catch (err) {
            console.error(`  classify error for ${it.idweb}: ${err}`);
            return { category: "relevant", reason: "erreur classification — revue manuelle" };
          }
        };

  const concurrency = mode === "regex" ? items.length : 5;
  const classifications = await mapConcurrent(items, classifyOne, concurrency);

  const relevant: Matched[] = [];
  const travaux: Matched[] = [];
  const excluded: Matched[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const cls = classifications[i]!;
    const enriched: Matched = { ...it, reason: cls.reason };
    if (cls.category === "relevant") relevant.push(enriched);
    else if (cls.category === "travaux") travaux.push(enriched);
    else excluded.push(enriched);
  }

  const generatedAt = new Date().toISOString();

  await Bun.write(
    "avis-en-cours.md",
    renderMarkdown(relevant, {
      title: "Avis en cours — scope principal (études de mobilité)",
      subtitle:
        "Filtres: `type_marche=SERVICES`, statut *en cours*, toutes départements. " +
        "Exclus: contrôle de travaux, services télécom/téléphonie. " +
        "Les avis de type *travaux* sont dans `avis-travaux.md`.",
      generatedAt,
    }),
  );

  await Bun.write(
    "avis-travaux.md",
    renderMarkdown(travaux, {
      title: "Avis — travaux (hors scope du cabinet)",
      subtitle:
        "Avis contenant des mots-clés *travaux* (MOE, rénovation, fouilles, isolation…). " +
        "Listés à titre indicatif — le cabinet ne fait pas de travaux.",
      generatedAt,
    }),
  );

  console.error("\n=== classification ===");
  console.error(`relevant: ${relevant.length}   travaux: ${travaux.length}   excluded: ${excluded.length}`);
  if (excluded.length > 0) {
    console.error("\nexcluded:");
    for (const e of excluded) {
      console.error(`  - [${e.idweb}] ${e.reason} — ${e.objet.slice(0, 80)}`);
    }
  }
  console.error(`\nwrote avis-en-cours.md (${relevant.length}) and avis-travaux.md (${travaux.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
