// Catalogue public des modèles OpenRouter (GET /models, sans clé) : prix du
// jour et support du mode JSON, pour valider la chaîne saisie sur
// /configuration et proposer les modèles les moins chers. Utilisé par le
// serveur uniquement — jamais par le job quotidien (run.ts), qui ne doit pas
// dépendre d'un appel réseau de plus.
import { openRouterBaseUrl, openRouterHeaders, openRouterKey, formatUsd } from "./llm.ts";

export type CatalogModel = {
  id: string;
  name: string;
  // USD par million de tokens (le catalogue donne un prix par token).
  promptPerM: number;
  completionPerM: number;
  contextLength: number | null;
  // supported_parameters contient response_format (mode JSON).
  json: boolean;
  textIn: boolean;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
};

function perM(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n * 1e6 : Number.NaN;
}

export function parseCatalog(raw: unknown): CatalogModel[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const m of data as RawModel[]) {
    if (typeof m?.id !== "string") continue;
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : [];
    const inputs = Array.isArray(m.architecture?.input_modalities)
      ? (m.architecture!.input_modalities as unknown[])
      : ["text"];
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      promptPerM: perM(m.pricing?.prompt),
      completionPerM: perM(m.pricing?.completion),
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
      json: params.includes("response_format"),
      textIn: inputs.includes("text"),
    });
  }
  return out;
}

// Modèles utilisables par le classifieur : texte en entrée, mode JSON, prix
// connu et payant (les :free sont limités à ~20 req/min et collectent les
// données ; les pseudo-modèles openrouter/* n'ont pas de prix fixe).
export function usable(m: CatalogModel): boolean {
  return (
    m.json &&
    m.textIn &&
    Number.isFinite(m.promptPerM) &&
    Number.isFinite(m.completionPerM) &&
    m.promptPerM >= 0 &&
    m.completionPerM >= 0 &&
    !m.id.endsWith(":free") &&
    !m.id.startsWith("openrouter/")
  );
}

// Le prompt (~1 500 tokens) pèse bien plus que la réponse (~30) : tri sur le
// prix d'entrée, puis de sortie.
export function cheapestJson(models: CatalogModel[], n: number): CatalogModel[] {
  return models
    .filter(usable)
    .sort((a, b) => a.promptPerM - b.promptPerM || a.completionPerM - b.completionPerM)
    .slice(0, n);
}

// Suggestions pour la liste déroulante : les modèles recommandés présents au
// catalogue (dans l'ordre), puis les moins chers non encore listés.
export function suggestions(models: CatalogModel[], recommended: readonly string[], n: number): CatalogModel[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const out: CatalogModel[] = [];
  for (const id of recommended) {
    const m = byId.get(id);
    if (m && !out.includes(m)) out.push(m);
  }
  for (const m of cheapestJson(models, n)) {
    if (out.length >= n) break;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

export function priceLabel(m: CatalogModel): string {
  if (!Number.isFinite(m.promptPerM)) return "prix inconnu";
  return `${formatUsd(m.promptPerM)} / ${formatUsd(m.completionPerM)} par M tokens`;
}

const CATALOG_TTL_MS = 60 * 60_000;
let cache: { at: number; models: CatalogModel[] } | null = null;

export type CatalogFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CatalogDeps = { fetchImpl?: CatalogFetch; now?: () => number };

// null = catalogue indisponible (réseau, délai, réponse inattendue) : la
// validation syntaxique seule s'applique, jamais de blocage sur OpenRouter.
export async function fetchCatalog(deps: CatalogDeps = {}): Promise<CatalogModel[] | null> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < CATALOG_TTL_MS) return cache.models;
  try {
    const doFetch: CatalogFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
    const res = await doFetch(`${openRouterBaseUrl()}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const models = parseCatalog(await res.json());
    if (models.length === 0) return null;
    cache = { at: now(), models };
    return models;
  } catch {
    return null;
  }
}

export function resetCatalogCache(): void {
  cache = null;
}

export type KeyCredit = { usage: number; limit: number | null; remaining: number | null };

// GET /auth/key : consommation et plafond de la clé (crédit restant si
// OpenRouter le calcule). Tolérant : null si absent ou injoignable.
export async function fetchKeyCredit(deps: CatalogDeps = {}): Promise<KeyCredit | null> {
  const key = openRouterKey();
  if (!key) return null;
  try {
    const doFetch: CatalogFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
    const res = await doFetch(`${openRouterBaseUrl()}/auth/key`, {
      headers: openRouterHeaders(key),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: Record<string, unknown> })?.data;
    if (!data) return null;
    const usage = Number(data.usage ?? 0);
    const limit = typeof data.limit === "number" ? data.limit : null;
    const remaining =
      typeof data.limit_remaining === "number"
        ? data.limit_remaining
        : limit !== null
          ? limit - usage
          : null;
    return { usage: Number.isFinite(usage) ? usage : 0, limit, remaining };
  } catch {
    return null;
  }
}

export function creditLabel(c: KeyCredit): string {
  const used = `${formatUsd(c.usage)} consommés`;
  return c.remaining !== null ? `${used}, reste ${formatUsd(c.remaining)}` : used;
}
