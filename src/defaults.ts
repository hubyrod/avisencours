import type { SearchParams } from "./params.ts";

export const KEYWORDS = [
  "mobilité",
  "déplacement",
  "vélo",
  "cyclable",
  "piéton",
  "stationnement",
  "intermodalité",
  '"pôle d\'échange"',
  '"transports collectifs"',
  '"plan de mobilité"',
  '"schéma directeur"',
  '"modélisation trafic"',
  '"évaluation socio-économique"',
  "comptage",
];

export const DEFAULT_QUERY = KEYWORDS.join(" OR ");

// Chaîne de modèles OpenRouter par défaut. En tête, llama-3.3-70b : 40/40 au
// banc d'essai (`bun run eval`, 2026-09) pour ~0,10 $/M tokens en entrée, soit
// moins d'un centime par run. Puis mistral-nemo (38/40, cinq fois moins cher)
// et un troisième éditeur pour survivre à une panne. Surchargée par
// LLM_MODELS (env) puis par le réglage « llm_models » en base (/configuration).
export const DEFAULT_LLM_MODELS: readonly string[] = [
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-nemo",
  "google/gemini-2.5-flash-lite",
];

// Suggestions affichées en tête de liste sur /configuration : modèles bon
// marché connus pour répondre correctement en JSON. Le catalogue OpenRouter
// complète cette liste avec les prix du jour.
export const RECOMMENDED_MODELS: readonly string[] = [
  ...DEFAULT_LLM_MODELS,
  "qwen/qwen3-235b-a22b-2507",
  "mistralai/mistral-small-3.2-24b-instruct",
  "mistralai/mistral-small-24b-instruct-2501",
  "openai/gpt-4.1-nano",
  "meta-llama/llama-3.1-8b-instruct",
  "qwen/qwen3-30b-a3b-instruct-2507",
];

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildDefaultParams(query: string = DEFAULT_QUERY): SearchParams {
  return {
    query,
    typeMarche: ["SERVICES"],
    sort: "datelimitereponse ASC",
    deadlineFrom: today(),
  };
}
