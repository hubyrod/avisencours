import type { SearchParams } from "./params.ts";
import type { FamilleSearch } from "./familles.ts";

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

// Recherches achatpublic.com (src/achatpublic.ts), reprises de la procédure de
// veille manuelle du cabinet : une nature de marché et des mots-clés par
// famille, comparés en début de mot sur l'intitulé de chaque consultation
// ouverte. La famille « mobilité » est ensuite classée comme les avis BOAMP ;
// « kiomda » (fourniture de compteurs) et « inondations » (études AMC /
// prévention des inondations) par une règle propre (src/familles.ts).
export const ACHATPUBLIC_SEARCHES: readonly FamilleSearch[] = [
  {
    famille: "mobilité",
    marche: "services",
    keywords: [
      "vélo", "ferroviaire", "mobilité", "déplacement", "planification", "trafic",
      "circulation", "microsimulation", "model", "PDM", "TCSP", "marchandises",
      "fret", "multimodal", "gare", "échange", "jalonnement", "enquête",
      "covoiturage", "tarif", "cyclable", "itinéraire", "schéma", "signalisation",
      "voie verte", "stationnement", "piéton", "autopartage", "accessibilité",
      "ZFE", "desserte", "intermodal", "voirie", "scot", "prospective",
      "socioéconomique", "socio", "fréquentation", "économique", "statistique",
      "étude", "multicritère", "multi-critère", "AMC", "MCDA",
    ],
  },
  {
    famille: "kiomda",
    marche: "fournitures",
    keywords: ["compteur", "capteur", "vélo", "piéton"],
  },
  {
    famille: "inondations",
    marche: "services",
    keywords: [
      "AMC", "multicritère", "multi-critère", "MCDA", "prévention des inondations",
      "SYMAR", "PAPI", "GEMAPI", "syndicat de rivière",
    ],
  },
];

// Chaîne de modèles OpenRouter par défaut, ordonnée par prix : le banc d'essai
// (`bun run eval`, 2026-09) donne mistral-nemo à 39/40 pour 0,019 $/M tokens
// en entrée — le modèle JSON le moins cher du catalogue (~5 centimes par
// run quotidien de ~2 000 appels). Puis mistral-small-24b
// (39/40, 0,05 $/M) et llama-3.1-8b (37/40, 0,05 $/M, autre éditeur) pour
// survivre à une panne. llama-3.3-70b (40/40) coûte cinq fois plus cher.
// Surchargée par LLM_MODELS (env) puis par le réglage « llm_models » en base
// (/configuration).
export const DEFAULT_LLM_MODELS: readonly string[] = [
  "mistralai/mistral-nemo",
  "mistralai/mistral-small-24b-instruct-2501",
  "meta-llama/llama-3.1-8b-instruct",
];

// Suggestions affichées en tête de liste sur /configuration : modèles bon
// marché connus pour répondre correctement en JSON. Le catalogue OpenRouter
// complète cette liste avec les prix du jour.
export const RECOMMENDED_MODELS: readonly string[] = [
  ...DEFAULT_LLM_MODELS,
  "meta-llama/llama-3.3-70b-instruct",
  "deepseek/deepseek-v4-flash-0731",
  "qwen/qwen3-30b-a3b-instruct-2507",
  "mistralai/mistral-small-3.2-24b-instruct",
  "google/gemini-2.5-flash-lite",
  "openai/gpt-4.1-nano",
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
