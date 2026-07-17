import { buildDefaultParams, DEFAULT_QUERY } from "./defaults.ts";
import { scrapeAll, type Announcement } from "./scraper.ts";
import { classify, type Category, type Classification } from "./classify.ts";
import { classifyLLM } from "./classify-llm.ts";
import { classifyHybrid } from "./classify-hybrid.ts";
import { applyScopeRules, type ScopeRules } from "./rules.ts";

const EXCLUDE_TYPE_AVIS = [/attribution/i, /résultat/i, /annulation/i];

function keep(a: Announcement): boolean {
  return !EXCLUDE_TYPE_AVIS.some((re) => re.test(a.typeAvis));
}

export type ClassifiedItem = Announcement & {
  matchedQueries: string[];
  category: Category;
  reason?: string;
};

export type ClassifierMode = "regex" | "llm" | "hybrid";

export type PipelineOptions = {
  query?: string;
  maxPages?: number;
  useCache?: boolean;
  cachePath?: string;
  classifier?: string;
  scopeRules?: ScopeRules;
  codeDepartement?: string[];
  log?: (msg: string) => void;
};

export type PipelineResult = {
  mode: ClassifierMode;
  relevant: ClassifiedItem[];
  travaux: ClassifiedItem[];
  excluded: ClassifiedItem[];
};

type CachedItem = Announcement & { matchedQueries: string[] };

async function loadOrScrape(
  query: string,
  maxPages: number,
  cachePath: string,
  useCache: boolean,
  codeDepartement: string[] | undefined,
  log: (msg: string) => void,
): Promise<CachedItem[]> {
  if (useCache) {
    const f = Bun.file(cachePath);
    if (await f.exists()) {
      log(`loading cache: ${cachePath}`);
      return (await f.json()) as CachedItem[];
    }
  }

  const params = buildDefaultParams(query);
  if (codeDepartement?.length) params.codeDepartement = codeDepartement;

  log(`query: ${query.length > 120 ? query.slice(0, 120) + "…" : query}`);

  const items = await scrapeAll(params, {
    maxPages,
    pageSize: 100,
    onPage: (n, batch) => log(`  page ${n}: ${batch.length} items`),
  });

  const byId = new Map<string, CachedItem>();
  for (const it of items.filter(keep)) {
    const key = it.idweb || it.url;
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, { ...it, matchedQueries: [query] });
  }

  const arr = [...byId.values()];
  await Bun.write(cachePath, JSON.stringify(arr, null, 2));
  log(`cached ${arr.length} unique avis -> ${cachePath}`);
  return arr;
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (t: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  // oxlint-disable-next-line no-new-array -- length-init; slots are filled by index below
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

function resolveMode(requested: string, log: (msg: string) => void): ClassifierMode {
  if (requested !== "regex" && requested !== "llm" && requested !== "hybrid") {
    throw new Error(`Invalid CLASSIFIER="${requested}" (expected: regex | llm | hybrid)`);
  }
  const needsKey = requested === "hybrid" || requested === "llm";
  if (needsKey && !Bun.env.MISTRAL_API_KEY) {
    log(`MISTRAL_API_KEY not set — falling back from ${requested} to regex`);
    return "regex";
  }
  return requested;
}

export async function runPipeline(opts: PipelineOptions = {}): Promise<PipelineResult> {
  const log = opts.log ?? ((msg) => console.error(msg));
  const query = opts.query ?? DEFAULT_QUERY;
  const maxPages = opts.maxPages ?? 100;
  const cachePath = opts.cachePath ?? ".cache/scrape.json";
  const useCache = opts.useCache ?? false;

  const items = await loadOrScrape(query, maxPages, cachePath, useCache, opts.codeDepartement, log);

  const mode = resolveMode(opts.classifier ?? "hybrid", log);
  log(`classifier: ${mode}`);

  const baseClassify =
    mode === "regex"
      ? async (it: Announcement): Promise<Classification> => classify(it)
      : async (it: Announcement): Promise<Classification> => {
          try {
            return mode === "hybrid" ? await classifyHybrid(it) : await classifyLLM(it);
          } catch (err) {
            log(`  classify error for ${it.idweb}: ${err}`);
            return { category: "relevant", reason: "erreur classification — revue manuelle" };
          }
        };

  // Règles personnalisées (/configuration) : tranchent avant les classifieurs.
  const rules = opts.scopeRules;
  let forcedKeep = 0;
  let forcedExclude = 0;
  const classifyOne = async (it: Announcement): Promise<Classification> => {
    const forced = rules ? applyScopeRules(it, rules) : null;
    if (forced) {
      if (forced.category === "relevant") forcedKeep++;
      else forcedExclude++;
      return forced;
    }
    return baseClassify(it);
  };

  const concurrency = mode === "regex" ? items.length : 5;
  const classifications = await mapConcurrent(items, classifyOne, concurrency);
  if (forcedKeep || forcedExclude) {
    log(`règles personnalisées: ${forcedKeep} gardé(s), ${forcedExclude} exclu(s)`);
  }

  const relevant: ClassifiedItem[] = [];
  const travaux: ClassifiedItem[] = [];
  const excluded: ClassifiedItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const cls = classifications[i]!;
    const enriched: ClassifiedItem = { ...it, category: cls.category, reason: cls.reason };
    if (cls.category === "relevant") relevant.push(enriched);
    else if (cls.category === "travaux") travaux.push(enriched);
    else excluded.push(enriched);
  }

  return { mode, relevant, travaux, excluded };
}
