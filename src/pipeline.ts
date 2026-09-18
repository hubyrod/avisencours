import { ACHATPUBLIC_SEARCHES, MARCHESONLINE_SEARCHES, MPE_SEARCHES, buildDefaultParams, DEFAULT_QUERY } from "./defaults.ts";
import { scrapeAll, type Announcement } from "./scraper.ts";
import { scrapeAchatPublic } from "./achatpublic.ts";
import { scrapeAfd } from "./afd.ts";
import { MPE_SITES, scrapeMpe } from "./mpe.ts";
import { scrapeMarchesOnline } from "./marchesonline.ts";
import { isSourceEnabled, sourceLabel } from "./sources.ts";
import { classifyFamille } from "./familles.ts";
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
  // Sources secondaires (défaut : activées sauf ACHATPUBLIC=0 / AFD=0, et par
  // site MPE : MAXIMILIEN=0 / AMPA=0 — voir MPE_SITES).
  achatPublic?: boolean;
  afd?: boolean;
  mpe?: boolean;
  marchesOnline?: boolean;
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

async function scrapeBoamp(
  query: string,
  maxPages: number,
  codeDepartement: string[] | undefined,
  log: (msg: string) => void,
): Promise<CachedItem[]> {
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

  return [...byId.values()];
}

// Sources secondaires (achatpublic.com, AFD/dgMarket) : non bloquantes — une
// panne d'un site (ou un changement de sa page) ne doit pas faire échouer la
// veille BOAMP ; elle remonte en avertissement (email d'alerte, page
// configuration) et ses avis ne sont simplement pas revus ce jour-là.
type SecondarySource = { name: string; run: () => Promise<Announcement[]> };

async function scrapeSecondary(
  sources: SecondarySource[],
  codeDepartement: string[] | undefined,
  log: (msg: string) => void,
): Promise<{ items: CachedItem[]; warnings: string[] }> {
  const items: CachedItem[] = [];
  const warnings: string[] = [];
  for (const src of sources) {
    log(`${src.name}: lecture des avis en cours…`);
    try {
      for (const it of (await src.run()).filter(keep)) {
        // Filtre départements : ne s'applique qu'aux avis dont on connaît le code
        // (une consultation « France entière » ou un pays étranger passe).
        const codes = it.department.split(",").map((c) => c.trim()).filter((c) => /^(\d{2,3}|2A|2B)$/.test(c));
        if (codeDepartement?.length && codes.length > 0 && !codes.some((c) => codeDepartement.includes(c))) continue;
        items.push({ ...it, matchedQueries: (it as Partial<CachedItem>).matchedQueries ?? [] });
      }
    } catch (err) {
      const warning = `${src.name} indisponible — ${errMessage(err)} — ses avis ne sont pas mis à jour ce run`;
      log(warning);
      warnings.push(warning);
    }
  }
  return { items, warnings };
}

async function loadAll(
  opts: PipelineOptions,
  query: string,
  maxPages: number,
  cachePath: string,
  useCache: boolean,
  log: (msg: string) => void,
): Promise<{ items: CachedItem[]; warning?: string }> {
  if (useCache) {
    const f = Bun.file(cachePath);
    if (await f.exists()) {
      log(`loading cache: ${cachePath}`);
      const cached = (await f.json()) as Array<Partial<CachedItem> & Announcement>;
      // Cache antérieur aux champs source / famille : c'était du BOAMP.
      return {
        items: cached.map((it) => ({
          ...it,
          matchedQueries: it.matchedQueries ?? [],
          source: it.source ?? "boamp",
          famille: it.famille ?? "mobilité",
        })),
      };
    }
  }
  const boamp = await scrapeBoamp(query, maxPages, opts.codeDepartement, log);
  // Activation : option explicite, sinon la variable d'environnement de la
  // source (src/sources.ts — même registre que la page de configuration).
  const sources: SecondarySource[] = [];
  if (opts.achatPublic ?? isSourceEnabled("achatpublic")) {
    sources.push({ name: sourceLabel("achatpublic"), run: () => scrapeAchatPublic({ searches: ACHATPUBLIC_SEARCHES, log }) });
  }
  if (opts.afd ?? isSourceEnabled("afd")) sources.push({ name: sourceLabel("afd"), run: () => scrapeAfd({ log }) });
  for (const site of MPE_SITES) {
    if (opts.mpe ?? isSourceEnabled(site.source)) {
      sources.push({ name: sourceLabel(site.source), run: () => scrapeMpe({ site, searches: MPE_SEARCHES, log }) });
    }
  }
  if (opts.marchesOnline ?? isSourceEnabled("marchesonline")) {
    sources.push({ name: sourceLabel("marchesonline"), run: () => scrapeMarchesOnline({ searches: MARCHESONLINE_SEARCHES, log }) });
  }
  const secondary = await scrapeSecondary(sources, opts.codeDepartement, log);
  const ids = new Set(boamp.map((it) => it.idweb));
  const items = [...boamp, ...secondary.items.filter((it) => !ids.has(it.idweb))];
  await Bun.write(cachePath, JSON.stringify(items, null, 2));
  log(`cached ${items.length} unique avis (${boamp.length} BOAMP, ${items.length - boamp.length} sources secondaires) -> ${cachePath}`);
  return { items, warning: secondary.warnings.join(" ; ") || undefined };
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

  const loaded = await loadAll(opts, query, maxPages, cachePath, useCache, log);
  const items = loaded.items;

  const resolved = resolveMode(opts.classifier ?? "hybrid", log);
  const mode = resolved.mode;
  let warning = [loaded.warning, resolved.warning].filter(Boolean).join(" ; ") || undefined;
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
    // Familles hors mobilité (achatpublic) : règle propre, jamais le LLM.
    return classifyFamille(it.famille, it) ?? baseClassify(it);
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
