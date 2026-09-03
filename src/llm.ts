// Client OpenRouter (API compatible OpenAI) : un appel « réponds en JSON »
// avec chaîne de repli. Deux niveaux de repli :
//   1. côté OpenRouter, via `models` : si le premier modèle est en panne,
//      limité en débit, refuse (modération) ou déborde le contexte, le suivant
//      prend le relais dans la même requête — le champ `model` de la réponse
//      dit qui a répondu (et qui est facturé) ;
//   2. côté client, une seule fois, quand la réponse HTTP 200 est inutilisable
//      (JSON invalide, contenu vide, tronqué…) : nouvelle requête avec la
//      chaîne amputée de sa tête.
// Les fournisseurs d'un même modèle sont triés par prix (`provider.sort`) et
// filtrés sur le support de `response_format` (`require_parameters`).
//
// Aucune dépendance npm : fetch + JSON. Ce module ne touche pas la base.
import { DEFAULT_LLM_MODELS } from "./defaults.ts";
import { HttpError, postWithRetry, type FetchLike, errMessage } from "./http.ts";
import { validateModelChain, parseModelChain } from "./rules.ts";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

export type ChatDeps = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export type ChatOptions<T> = {
  messages: Msg[];
  models: string[];
  // Transforme le texte renvoyé en valeur ; doit lever si le contenu est
  // inutilisable (déclenche le repli côté client).
  parse: (content: string) => T;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ChatResult<T> = {
  value: T;
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  retries: number;
  rotated: boolean;
};

// 401 / 402 : problème de compte (clé invalide, crédit épuisé) — inutile
// d'insister, chaque avis échouerait pareil. Déclenche le coupe-circuit.
export class LlmAuthError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`OpenRouter ${status}: ${body.slice(0, 300)}`);
    this.name = "LlmAuthError";
    this.status = status;
  }
}

// Réponse HTTP 200 mais contenu inexploitable.
export class LlmContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmContentError";
  }
}

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function openRouterBaseUrl(): string {
  return (Bun.env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function openRouterKey(): string | undefined {
  const k = Bun.env.OPENROUTER_API_KEY?.trim();
  return k ? k : undefined;
}

export function llmConfigured(): boolean {
  return Boolean(openRouterKey());
}

// Prix plafond par million de tokens (entrée et sortie), garde-fou contre un
// identifiant de modèle coûteux saisi par erreur.
export function maxPricePerM(): number {
  const raw = Number(Bun.env.LLM_MAX_PRICE_PER_M ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

// Chaîne par défaut hors base : LLM_MODELS (env) sinon defaults.ts.
// Une valeur d'environnement invalide est une erreur de configuration : on
// lève plutôt que de classer silencieusement avec autre chose.
export function defaultModelChain(): string[] {
  const env = Bun.env.LLM_MODELS?.trim();
  if (!env) return [...DEFAULT_LLM_MODELS];
  const v = validateModelChain(env);
  if (!v.ok) throw new Error(`LLM_MODELS invalide — ${v.error}`);
  return parseModelChain(v.value);
}

export function openRouterHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": Bun.env.DASHBOARD_URL ?? "https://github.com/hubyrod/avisencours",
    "X-Title": "avis-en-cours",
  };
}

// Extraction tolérante : les petits modèles entourent parfois le JSON de
// ```json … ``` ou d'une phrase. On prend le premier objet { … }.
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LlmContentError(`no JSON object in: ${text.slice(0, 120)}`);
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (e) {
    throw new LlmContentError(`invalid JSON (${errMessage(e)}): ${text.slice(0, 120)}`);
  }
}

type OpenRouterResponse = {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
    error?: { message?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
};

async function requestOnce<T>(
  key: string,
  models: string[],
  opts: ChatOptions<T>,
  deps: ChatDeps,
): Promise<ChatResult<T>> {
  const multi = models.length > 1;
  const cap = maxPricePerM();
  const body = JSON.stringify({
    model: models[0],
    models: multi ? models : undefined,
    messages: opts.messages,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 200,
    response_format: { type: "json_object" },
    provider: { sort: "price", require_parameters: true, max_price: { prompt: cap, completion: cap } },
    usage: { include: true },
  });

  let res: Response;
  let retries: number;
  try {
    ({ res, retries } = await postWithRetry(
      "OpenRouter",
      `${openRouterBaseUrl()}/chat/completions`,
      { headers: openRouterHeaders(key), body },
      {
        // Avec plusieurs modèles, chaque réessai refait parcourir toute la
        // chaîne côté OpenRouter : moins de tentatives, délai plus long.
        attempts: multi ? 2 : 4,
        timeoutMs: opts.timeoutMs ?? (multi ? 45_000 : 30_000),
        attemptsFor: (status) => (status === 503 ? 2 : undefined),
        signal: opts.signal,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      },
    ));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 402)) {
      throw new LlmAuthError(err.status, err.body);
    }
    throw err;
  }

  const data = (await res.json()) as OpenRouterResponse;
  if (data.error) {
    throw new LlmContentError(`OpenRouter error in 200 body: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  const choice = data.choices?.[0];
  if (choice?.error) throw new LlmContentError(`provider error: ${choice.error.message ?? "?"}`);
  const content = choice?.message?.content ?? "";
  if (!content.trim()) throw new LlmContentError(`empty content (finish_reason=${choice?.finish_reason ?? "?"})`);
  if (choice?.finish_reason === "length") throw new LlmContentError("response truncated (finish_reason=length)");

  return {
    value: opts.parse(content),
    content,
    model: data.model ?? models[0]!,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    costUsd: data.usage?.cost ?? 0,
    retries,
    rotated: false,
  };
}

// OpenRouter valide tous les identifiants de `models` avant de router : un
// seul identifiant inconnu (faute de frappe, modèle retiré du catalogue)
// renvoie 400 pour toute la requête au lieu de passer au suivant.
export function invalidModelId(err: unknown): string | null {
  if (!(err instanceof HttpError) || err.status !== 400) return null;
  const m = err.body.match(/"([^"\s]+\/[^"\s]+) is not a valid model ID"/);
  return m?.[1] ?? null;
}

export async function chatJSON<T>(opts: ChatOptions<T>, deps: ChatDeps = {}): Promise<ChatResult<T>> {
  const key = openRouterKey();
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  if (opts.models.length === 0) throw new Error("empty model chain");

  let models = opts.models;
  let dropped = false;
  for (;;) {
    try {
      const r = await requestOnce(key, models, opts, deps);
      return dropped ? { ...r, rotated: true } : r;
    } catch (err) {
      // Identifiant refusé par OpenRouter : on le retire de la chaîne et on
      // réessaie avec le reste (une fois par identifiant, au plus).
      const bad = invalidModelId(err);
      if (bad && models.includes(bad) && models.length > 1) {
        models = models.filter((m) => m !== bad);
        dropped = true;
        continue;
      }
      // Repli client : une seule fois, uniquement sur contenu inutilisable
      // (les erreurs HTTP ont déjà parcouru la chaîne côté OpenRouter).
      const rest = models.slice(1);
      if (!(err instanceof LlmContentError) || rest.length === 0) throw err;
      const second = await requestOnce(key, rest, opts, deps);
      return { ...second, rotated: true };
    }
  }
}

// --- Statistiques d'un run + coupe-circuit --------------------------------------

export type LlmStats = {
  calls: number;
  errors: number;
  retries: number;
  // Réponses données par un autre modèle que la tête de chaîne.
  fallbacks: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  byModel: Record<string, number>;
  breakerTripped: boolean;
  breakerReason?: string;
};

export function newLlmStats(): LlmStats {
  return {
    calls: 0,
    errors: 0,
    retries: 0,
    fallbacks: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    byModel: {},
    breakerTripped: false,
  };
}

export function recordCall(stats: LlmStats, r: ChatResult<unknown>, chain: string[]): void {
  stats.calls++;
  stats.retries += r.retries;
  if (r.rotated || r.model !== chain[0]) stats.fallbacks++;
  stats.promptTokens += r.promptTokens;
  stats.completionTokens += r.completionTokens;
  stats.costUsd += r.costUsd;
  stats.byModel[r.model] = (stats.byModel[r.model] ?? 0) + 1;
}

// Coupe-circuit partagé par les workers d'un run : se déclenche sur la
// première erreur de compte (401/402) ou après N échecs consécutifs de toute
// la chaîne. Une fois ouvert, il annule les requêtes en vol (signal) et le
// pipeline bascule sur le classifieur regex pour les avis restants.
export class Breaker {
  private readonly controller = new AbortController();
  private consecutive = 0;
  tripped = false;
  reason?: string;

  constructor(private readonly threshold = 5) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  success(): void {
    this.consecutive = 0;
  }

  failure(err: unknown): void {
    if (this.tripped) return;
    if (err instanceof LlmAuthError) {
      this.trip(
        err.status === 402
          ? `crédit OpenRouter épuisé (402) — ${err.message}`
          : `clé OpenRouter refusée (${err.status}) — ${err.message}`,
      );
      return;
    }
    this.consecutive++;
    if (this.consecutive >= this.threshold) {
      this.trip(`${this.threshold} échecs LLM consécutifs — dernier : ${errMessage(err)}`);
    }
  }

  private trip(reason: string): void {
    this.tripped = true;
    this.reason = reason;
    const e = new Error(`coupe-circuit LLM ouvert : ${reason}`);
    e.name = "AbortError";
    this.controller.abort(e);
  }
}

// Deux décimales minimum, jusqu'à quatre pour les très petits montants
// (un run coûte quelques millièmes de dollar), sans zéros de queue inutiles.
export function formatUsd(n: number): string {
  const max = n === 0 ? 2 : n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: max })} $`;
}

// « 37 appels, 0,004 $ (mistral-nemo ×35, mistral-small-3.2 ×2) »
export function llmStatsSummary(s: LlmStats): string {
  const models = Object.entries(s.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m.replace(/^[^/]+\//, "")} ×${n}`)
    .join(", ");
  const parts = [`${s.calls} appel${s.calls > 1 ? "s" : ""}`, formatUsd(s.costUsd)];
  if (models) parts.push(`(${models})`);
  const extra: string[] = [];
  if (s.errors) extra.push(`${s.errors} erreur${s.errors > 1 ? "s" : ""}`);
  if (s.retries) extra.push(`${s.retries} réessai${s.retries > 1 ? "s" : ""}`);
  if (s.fallbacks) extra.push(`${s.fallbacks} repli${s.fallbacks > 1 ? "s" : ""}`);
  return parts.join(" ") + (extra.length ? ` — ${extra.join(", ")}` : "");
}
