// Logique pure de la configuration déléguée (/configuration) : règles de tri
// pré-classifieur, assemblage de la requête depuis les mots-clés en base, et
// validation des saisies. Aucun accès DB/env ici — testable avec `bun test`,
// importable aussi bien par run.ts que par server.ts.
import { normalize, type Classification } from "./classify.ts";

export type ScopeRules = { keep: string[]; exclude: string[] };

// Règles « toujours garder » / « toujours exclure », appliquées AVANT les
// classifieurs (un avis forcé « garder » ne coûte donc aucun appel Mistral).
// Correspondance en sous-chaîne sur texte normalisé (sans accents, minuscules).
// « garder » l'emporte sur « exclure » : les termes d'exclusion sont génériques,
// les termes à garder sont la soupape spécifique — le spécifique gagne.
export function applyScopeRules(
  a: { objet: string; raw: string },
  rules: ScopeRules,
): Classification | null {
  const haystack = normalize(`${a.objet} ${a.raw}`);
  const keepHit = rules.keep.find((t) => haystack.includes(normalize(t)));
  if (keepHit) {
    return { category: "relevant", reason: `règle personnalisée — toujours garder (« ${keepHit} »)` };
  }
  const excludeHit = rules.exclude.find((t) => haystack.includes(normalize(t)));
  if (excludeHit) {
    return { category: "excluded", reason: `règle personnalisée — exclu (« ${excludeHit} »)` };
  }
  return null;
}

// Les termes sont stockés sans guillemets ; les expressions de plusieurs mots
// sont recollées en "…" pour traverser parseQueryTerms (split sur ` OR `).
export function buildQueryFromKeywords(terms: string[]): string {
  return terms.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");
}

export type Validation = { ok: true; value: string } | { ok: false; error: string };

export function validateKeyword(raw: string): Validation {
  const term = raw.trim().replace(/"/g, "");
  if (term.length < 2) return { ok: false, error: "Mot-clé trop court (2 caractères minimum)." };
  if (term.length > 80) return { ok: false, error: "Mot-clé trop long (80 caractères maximum)." };
  // ` OR ` est le séparateur de la requête : un terme qui en contient un serait
  // silencieusement scindé en deux mots-clés (parseQueryTerms, src/params.ts).
  if (/\sOR\s/.test(term) || /^OR\s/.test(term) || /\sOR$/.test(term) || term === "OR") {
    return { ok: false, error: "Un mot-clé ne peut pas contenir le mot « OR »." };
  }
  return { ok: true, value: term };
}

export function validateRuleTerm(raw: string): Validation {
  const term = raw.trim();
  if (term.length < 2) return { ok: false, error: "Terme trop court (2 caractères minimum)." };
  if (term.length > 120) return { ok: false, error: "Terme trop long (120 caractères maximum)." };
  if (normalize(term).trim().length === 0) return { ok: false, error: "Terme invalide." };
  return { ok: true, value: term };
}

export function validateDigestWindow(raw: string): Validation {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    return { ok: false, error: "La fenêtre des échéances doit être un nombre entier de jours entre 1 et 60." };
  }
  return { ok: true, value: String(n) };
}

export function validateClassifierMode(raw: string): Validation {
  const mode = raw.trim();
  if (mode !== "regex" && mode !== "llm" && mode !== "hybrid") {
    return { ok: false, error: "Classifieur inconnu (attendu : regex, llm ou hybrid)." };
  }
  return { ok: true, value: mode };
}

// « 31, 2A, 974 » -> ["31", "2A", "974"] ; chaîne vide = toute la France.
export function parseDepartements(raw: string): { ok: true; codes: string[] } | { ok: false; error: string } {
  const codes = raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  for (const c of codes) {
    if (!/^(\d{2,3}|2A|2B)$/.test(c)) {
      return { ok: false, error: `Code département invalide : « ${c} ».` };
    }
  }
  return { ok: true, codes };
}
