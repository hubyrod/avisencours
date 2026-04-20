import type { SearchParams } from "./params.ts";

const KEYWORDS = [
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

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildDefaultParams(query: string = DEFAULT_QUERY): SearchParams {
  return {
    query,
    typeMarche: ["SERVICES"],
    sort: "dateparution",
    deadlineFrom: today(),
  };
}
