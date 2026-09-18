// Familles de veille : chaque source secondaire (achatpublic.com) est
// interrogée famille par famille — une nature de marché, une liste de
// mots-clés, et une règle de classement propre. La famille « mobilité » passe
// par les classifieurs habituels (regex / LLM) ; les autres familles sont hors
// du périmètre du prompt LLM et se classent par une règle dédiée.
import { normalize, type Category, type Classification } from "./classify.ts";
import type { Announcement } from "./scraper.ts";

export type Famille = "mobilité" | "kiomda" | "inondations";
export type NatureMarche = "services" | "fournitures";

export type FamilleSearch = {
  famille: Famille;
  marche: NatureMarche;
  keywords: readonly string[];
};

export const FAMILLE_LABELS: Record<Famille, string> = {
  mobilité: "Mobilité",
  kiomda: "Kiomda — compteurs",
  inondations: "Inondations — AMC",
};

// Correspondance d'un mot-clé sur texte normalisé, toujours en début de mot
// (« vélo » attrape « vélos » mais pas « développement »). Les sigles (écrits
// en majuscules : PDM, AMC, ZFE, PAPI…) et les mots très courts n'acceptent
// qu'un pluriel, les autres termes valent comme préfixe (« model » →
// « modélisation », « cyclable » → « cyclables »).
export function keywordRegex(term: string): RegExp {
  const clean = term.trim().replace(/^["«\s]+|["»\s]+$/g, "");
  const t = normalize(clean);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
  const sigle = clean === clean.toUpperCase() && /[A-Z]/.test(clean);
  const wholeWord = sigle || t.length <= 4;
  return wholeWord
    ? new RegExp(`(?<![a-z0-9])${escaped}s?(?![a-z0-9])`)
    : new RegExp(`(?<![a-z0-9])${escaped}`);
}

export function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const hay = normalize(text);
  return keywords.filter((k) => keywordRegex(k).test(hay));
}

const KIOMDA_OBJET = /\b(compteur|capteur|comptage|comptabilis)/;
const KIOMDA_CIBLE = /\b(velo|cycl|pieton|marche|trafic|routier|mobilite|deplacement|frequentation|circulation|vehicule)/;
const TRAVAUX_SIMPLE = /\b(travaux|maitrise d'oeuvre|moe\b|construction|realisation d'ouvrage)/;

// Classement des familles hors mobilité — règle pure, sans LLM.
export function classifyFamille(famille: Famille, a: Announcement): Classification | null {
  if (famille === "mobilité") return null;
  const hay = normalize(`${a.objet} ${a.raw}`);
  if (famille === "kiomda") {
    if (KIOMDA_OBJET.test(hay) && KIOMDA_CIBLE.test(hay)) {
      return { category: "relevant", reason: "fourniture de compteurs / capteurs (Kiomda)", classifier: "regex" };
    }
    return {
      category: "excluded",
      reason: "fourniture sans lien avec le comptage vélo / piéton / trafic",
      classifier: "regex",
    };
  }
  // inondations : mot-clé spécifique par construction (AMC, PAPI, GEMAPI…).
  const tv = hay.match(TRAVAUX_SIMPLE);
  const category: Category = tv ? "travaux" : "relevant";
  return {
    category,
    reason: tv ? `travaux (« ${tv[0]} »)` : "étude prévention des inondations / analyse multicritère",
    classifier: "regex",
  };
}
