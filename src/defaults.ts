import type { SearchParams } from "./params.ts";

export const DEFAULT_DISJUNCTIVE_FACETS = [
  "type_marche",
  "descripteur_code",
  "dc",
  "code_departement",
  "type_avis",
  "famille",
] as const;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildDefaultParams(query: string): SearchParams {
  return {
    query,
    typeMarche: ["SERVICES"],
    sort: "dateparution",
    deadlineFrom: today(),
    disjunctiveFacets: [...DEFAULT_DISJUNCTIVE_FACETS],
  };
}
