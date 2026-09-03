import { buildDefaultParams, DEFAULT_QUERY } from "./defaults.ts";
import { scrapeAll, type Announcement } from "./scraper.ts";
import { classify, type Category, type Classification } from "./classify.ts";
import { classifyLLM, type LlmContext } from "./classify-llm.ts";
import { classifyHybrid } from "./classify-hybrid.ts";
import { applyScopeRules, type ScopeRules } from "./rules.ts";
import { Breaker, defaultModelChain, llmConfigured, llmStatsSummary, newLlmStats, type LlmStats } from "./llm.ts";
import { errMessage } from "./http.ts";

const EXCLUDE_TYPE_AVIS = [/attribution/i, /résultat/i, /annulation/i];

function keep(a: Announcement): boolean {
  return !EXCLUDE_TYPE_AVIS.some((re) => re.test(a.typeAvis));
}

export type ClassifiedItem = Announcement & {
  matchedQueries: string[];
  category: Category;
  reason?: string;
  classifier?: string;
};

export type ClassifierMode = "regex" | "llm" | "hybrid";

export type PipelineOptions = {
  query?: string;
  maxPages?: number;
  useCache?: boolean;
  cachePath?: string;
  classifier?: string;
  // Chaîne de modèles OpenRouter (ordre de repli). Vide/absent = LLM_MODELS
  // (env) puis DEFAULT_LLM_MODELS.
  llmModels?: string[];
  scopeRules?: ScopeRules;
  codeDepartement?: string[];
  log?: (msg: string) => void;
};

export type PipelineResult = {
  mode: ClassifierMode;
  relevant: ClassifiedItem[];
  travaux: ClassifiedItem[];
  excluded: ClassifiedItem[];
  // Compteurs LLM du run (absent en mode regex).
  llm?: LlmStats;
  // Non bloquant : classifieur LLM demandé mais indisponible, ou coupe-circuit
  // ouvert en cours de route. À remonter (email d'alerte, page configuration).
  warning?: string;
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

function resolveMode(
  requested: string,
  log: (msg: string) => void,
): { mode: ClassifierMode; warning?: string } {
  if (requested !== "regex" && requested !== "llm" && requested !== "hybrid") {
    throw new Error(`Invalid CLASSIFIER="${requested}" (expected: regex | llm | hybrid)`);
  }
  const needsKey = requested === "hybrid" || requested === "llm";
  if (needsKey && !llmConfigured()) {
    const warning = `classifieur « ${requested} » demandé mais OPENROUTER_API_KEY absente — classification regex seule`;
    log(warning);
    return { mode: "regex", warning };
  }
  return { mode: requested };
}

export async function runPipeline(opts: PipelineOptions = {}): Promise<PipelineResult> {
  const log = opts.log ?? ((msg) => console.error(msg));
  const query = opts.query ?? DEFAULT_QUERY;
  const maxPages = opts.maxPages ?? 100;
  const cachePath = opts.cachePath ?? ".cache/scrape.json";
  const useCache = opts.useCache ?? false;

  const items = await loadOrScrape(query, maxPages, cachePath, useCache, opts.codeDepartement, log);

  const resolved = resolveMode(opts.classifier ?? "hybrid", log);
  const mode = resolved.mode;
  let warning = resolved.warning;
  log(`classifier: ${mode}`);

  const ctx: LlmContext | null =
    mode === "regex"
      ? null
      : {
          models: opts.llmModels?.length ? opts.llmModels : defaultModelChain(),
          stats: newLlmStats(),
          breaker: new Breaker(),
        };
  if (ctx) log(`modèles: ${ctx.models.join(" → ")}`);

  const baseClassify = !ctx
    ? async (it: Announcement): Promise<Classification> => classify(it)
    : async (it: Announcement): Promise<Classification> => {
        // Coupe-circuit ouvert (clé refusée, crédit épuisé, chaîne en panne) :
        // le reste du run est classé par les règles regex.
        if (ctx.breaker.tripped) return classify(it);
        try {
          return mode === "hybrid" ? await classifyHybrid(it, ctx) : await classifyLLM(it, ctx);
        } catch (err) {
          log(`  classify error for ${it.idweb}: ${errMessage(err)}`);
          if (ctx.breaker.tripped) return classify(it);
          return { category: "relevant", reason: "erreur classification — revue manuelle", classifier: "erreur" };
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
      return { ...forced, classifier: "regle" };
    }
    return baseClassify(it);
  };

  const concurrency = mode === "regex" ? items.length : 5;
  const classifications = await mapConcurrent(items, classifyOne, concurrency);
  if (forcedKeep || forcedExclude) {
    log(`règles personnalisées: ${forcedKeep} gardé(s), ${forcedExclude} exclu(s)`);
  }

  if (ctx) {
    const s = ctx.stats;
    if (ctx.breaker.tripped) {
      s.breakerTripped = true;
      s.breakerReason = ctx.breaker.reason;
      warning = `coupe-circuit LLM ouvert : ${ctx.breaker.reason} — les avis restants ont été classés par regex`;
      log(warning);
    }
    log(`LLM: ${llmStatsSummary(s)}`);
  }

  const relevant: ClassifiedItem[] = [];
  const travaux: ClassifiedItem[] = [];
  const excluded: ClassifiedItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const cls = classifications[i]!;
    const enriched: ClassifiedItem = {
      ...it,
      category: cls.category,
      reason: cls.reason,
      classifier: cls.classifier,
    };
    if (cls.category === "relevant") relevant.push(enriched);
    else if (cls.category === "travaux") travaux.push(enriched);
    else excluded.push(enriched);
  }

  return { mode, relevant, travaux, excluded, llm: ctx?.stats, warning };
}
