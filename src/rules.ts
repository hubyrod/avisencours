// Logique pure de la configuration déléguée (/configuration) : règles de tri
// pré-classifieur, assemblage de la requête depuis les mots-clés en base, et
// validation des saisies. Aucun accès DB/env ici — testable avec `bun test`,
// importable aussi bien par run.ts que par server.ts.
import { normalize, type Classification } from "./classify.ts";
import { FAMILLES, FAMILLE_MARCHE, type Famille, type FamilleSearch } from "./familles.ts";
import type { Source } from "./scraper.ts";

// Listes de mots-clés : une par moteur de recherche. BOAMP interroge l'API
// (une requête OR, sans famille) ; les autres listent toutes les consultations
// ouvertes puis filtrent l'intitulé en début de mot (src/familles.ts,
// keywordRegex), famille par famille. Maximilien et AMPA (même logiciel atexo)
// partagent la liste « mpe ». AFD n'a pas de liste (catégorie « Transports »
// du site).
export type Liste = "boamp" | "achatpublic" | "mpe" | "marchesonline";

export type ListeInfo = {
  id: Liste;
  label: string;
  // Sources alimentées par la liste (identifiants du registre src/sources.ts).
  sources: readonly Source[];
  // Familles éditables ; BOAMP n'en a qu'une (la requête n'a pas de famille).
  familles: boolean;
  // Comment les termes sont appliqués, pour la page de configuration.
  description: string;
};

export const LISTES: readonly ListeInfo[] = [
  {
    id: "boamp",
    label: "BOAMP",
    sources: ["boamp"],
    familles: false,
    description:
      "Requête de l'API : un avis de services est récupéré s'il contient au moins un de ces termes, cherchés tels quels (les expressions de plusieurs mots aussi).",
  },
  {
    id: "achatpublic",
    label: "achatpublic.com",
    sources: ["achatpublic"],
    familles: true,
    description:
      "Toutes les consultations ouvertes (services et fournitures) sont listées puis filtrées : un terme retient une consultation s'il commence un mot de son intitulé.",
  },
  {
    id: "mpe",
    label: "Maximilien et Marchés publics d'Aquitaine",
    sources: ["maximilien", "ampa"],
    familles: true,
    description:
      "Même filtre en début de mot, sur l'intitulé et l'objet des consultations de services des deux plateformes atexo.",
  },
  {
    id: "marchesonline",
    label: "Marchés Online",
    sources: ["marchesonline"],
    familles: true,
    description:
      "Chaque terme est une recherche du site (ses 8 pages les plus récentes au plus), dont les cartes sont refiltrées en début de mot : un terme très large coûte des pages et du temps.",
  },
];

export function isListe(v: string | null | undefined): v is Liste {
  return LISTES.some((l) => l.id === v);
}

export function isFamille(v: string | null | undefined): v is Famille {
  return FAMILLES.includes(v as Famille);
}

export type KeywordLike = { liste: Liste; famille: Famille; term: string };

// Lignes de search_keywords -> recherches par liste, dans l'ordre des familles
// (une liste absente de la table n'apparaît pas : le pipeline se replie sur
// defaults.ts ; une famille sans terme n'est pas cherchée).
export function searchesByListe(rows: readonly KeywordLike[]): Partial<Record<Liste, FamilleSearch[]>> {
  const out: Partial<Record<Liste, FamilleSearch[]>> = {};
  for (const l of LISTES) {
    const mine = rows.filter((r) => r.liste === l.id);
    if (mine.length === 0) continue;
    out[l.id] = FAMILLES.flatMap((famille) => {
      const keywords = mine.filter((r) => r.famille === famille).map((r) => r.term);
      return keywords.length > 0 ? [{ famille, marche: FAMILLE_MARCHE[famille], keywords }] : [];
    });
  }
  return out;
}

export type ScopeRules = { keep: string[]; exclude: string[] };

// Règles « toujours garder » / « toujours exclure », appliquées AVANT les
// classifieurs (un avis forcé « garder » ne coûte donc aucun appel LLM).
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

// Chaîne de modèles OpenRouter « editeur/modele[:floor|:nitro], … » dans
// l'ordre de repli. 5 modèles maximum. Les variantes :free (20 req/min,
// données collectées), :online (recherche web facturée) et :thinking
// (raisonnement qui consomme max_tokens avant de répondre) sont refusées.
export const MAX_MODEL_CHAIN = 5;
const MODEL_SLUG = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?::(?:floor|nitro))?$/;

export function validateModelChain(raw: string): Validation {
  const models = parseModelChain(raw);
  if (models.length === 0) return { ok: false, error: "Indiquez au moins un modèle." };
  if (models.length > MAX_MODEL_CHAIN) {
    return { ok: false, error: `${MAX_MODEL_CHAIN} modèles maximum dans la chaîne de repli.` };
  }
  for (const m of models) {
    if (!MODEL_SLUG.test(m)) {
      return {
        ok: false,
        error: `Identifiant de modèle invalide : « ${m} » (attendu : editeur/modele, ex. mistralai/mistral-nemo).`,
      };
    }
  }
  if (new Set(models).size !== models.length) {
    return { ok: false, error: "Un modèle apparaît deux fois dans la chaîne." };
  }
  return { ok: true, value: models.join(",") };
}

// "a/b, c/d" -> ["a/b", "c/d"] ; null / vide -> [].
export function parseModelChain(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
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
