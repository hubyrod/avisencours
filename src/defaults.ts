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

// Chaîne de modèles OpenRouter par défaut, du moins cher au plus sûr :
// mistral-nemo (~0,02 $/M tokens en entrée), puis le plus proche du modèle
// historique (mistral-small), puis un autre éditeur pour survivre à une panne
// Mistral. Surchargée par LLM_MODELS (env) puis par le réglage « llm_models »
// en base (/configuration). Ordre à confirmer avec `bun run eval`.
export const DEFAULT_LLM_MODELS: readonly string[] = [
  "mistralai/mistral-nemo",
  "mistralai/mistral-small-3.2-24b-instruct",
  "google/gemini-2.5-flash-lite",
];

// Suggestions affichées en tête de liste sur /configuration : modèles bon
// marché connus pour répondre correctement en JSON. Le catalogue OpenRouter
// complète cette liste avec les prix du jour.
export const RECOMMENDED_MODELS: readonly string[] = [
  ...DEFAULT_LLM_MODELS,
  "mistralai/mistral-small-24b-instruct-2501",
  "openai/gpt-4.1-nano",
  "openai/gpt-5-nano",
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
