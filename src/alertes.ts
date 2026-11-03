// Faut-il envoyer l'email d'alerte « mise à jour partielle » ? Seulement quand
// la situation se dégrade : une source qui tombe, ou un problème LLM qui
// apparaît. Une panne qui dure (Marchés Online bloqué depuis des semaines) ne
// vaut pas un email identique chaque matin — le digest quotidien rappelle
// déjà l'avertissement en pied de page. Logique pure, testée dans alertes.test.ts.
import { SOURCES } from "./sources.ts";
import type { Source } from "./scraper.ts";

export const LLM_ISSUE = /LLM|OPENROUTER|coupe-circuit/i;

// Les avertissements citent les sources par leur libellé (sourceLabel), ce
// que la page configuration exploite aussi pour afficher « en échec ».
export function failedSourcesFromWarning(warning: string | null | undefined): Source[] {
  if (!warning) return [];
  return SOURCES.filter((s) => warning.includes(s.label)).map((s) => s.id);
}

export function hasLlmIssue(warning: string | null | undefined): boolean {
  return !!warning && LLM_ISSUE.test(warning);
}

export type AlertDecision = { send: boolean; nouvelles: Source[]; llm: boolean };

// `previous` = avertissement du dernier run réussi (null : aucun).
export function alertDecision(previous: string | null | undefined, current: string | null | undefined): AlertDecision {
  if (!current) return { send: false, nouvelles: [], llm: false };
  const avant = new Set(failedSourcesFromWarning(previous));
  const nouvelles = failedSourcesFromWarning(current).filter((s) => !avant.has(s));
  const llm = hasLlmIssue(current) && !hasLlmIssue(previous);
  // Avertissement sans source ni LLM reconnaissables : on alerte par prudence
  // s'il change de texte.
  const inconnu = failedSourcesFromWarning(current).length === 0 && !hasLlmIssue(current) && current !== previous;
  return { send: nouvelles.length > 0 || llm || inconnu, nouvelles, llm };
}
