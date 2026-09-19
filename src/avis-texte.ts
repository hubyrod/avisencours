// Texte brut d'un avis (fragments joints par « — » par les scrapers) : les
// fragments non étiquetés forment la description (l'objet répété est écarté),
// les fragments « Libellé: valeur » deviennent des précisions (CPV, lieu, lots…).
export function decouperRaw(raw: string | null | undefined, objet: string): { description: string[]; precisions: Array<[string, string]> } {
  const description: string[] = [];
  const precisions: Array<[string, string]> = [];
  const vus = new Set<string>([objet.trim()]);
  for (const brut of (raw ?? "").split(/\s+—\s+/)) {
    const frag = brut.trim();
    if (!frag) continue;
    const m = frag.match(/^([A-Za-zÀ-ÿ' ]{2,20}):\s+(.+)$/s);
    if (m) {
      if (!/^(acheteur|departement|département|type d'avis|procedure|procédure|nature|pays|langue|type d'annonce)$/i.test(m[1]!)) {
        precisions.push([m[1]!, m[2]!.trim()]);
      }
      continue;
    }
    if (vus.has(frag)) continue;
    vus.add(frag);
    description.push(frag);
  }
  return { description, precisions };
}


// Avis au format eForms (BOAMP, Marchés Online…) aplati en une ligne :
// « 1. Acheteur 1.1 Acheteur Nom officiel: X Forme juridique: Y 2. Procédure
// 2.1 Procédure Titre: … Description: … 2.1.1 Objet … ». On retrouve les
// sections numérotées et les champs « Libellé: valeur », et on met en avant
// la première « Description ».
export type SectionAvis = { numero: string; titre: string; champs: Array<{ label: string; valeur: string }> };
export type TexteStructure = { resume: string | null; sections: SectionAvis[] };

// Numérotation eForms (« 1. », « 2.1 », « 5.1.11 ») suivie d'un titre en
// capitale, et pas juste après un « : » (« TVA: 0 Euro » n'est pas une section).
const SECTION = /(?:^|(?<=[^:\s]\s))(\d{1,2}(?:\.\d{1,2}){0,3}\.?)\s+(?=[A-ZÉÈÀÎÔ])/g;
// Libellé de champ eForms : première lettre en capitale, puis des mots en
// minuscules, un sigle court, une parenthèse ou une élision — jamais un autre
// mot capitalisé (« IRCEM agirc-arrco Forme juridique » n'est pas un libellé,
// « Forme juridique de l'acheteur » l'est), jamais de virgule, 72 caractères max.
const MIN = "a-zàâäéèêëîïôöùûüç";
const MOT = `(?:[${MIN}'’/-]+|[A-ZÉ]{2,5}|\\([^)]*\\)|[ld]'[${MIN}]+)`;
const LABEL = `[A-ZÉÈÀÎÔ][${MIN}'’/-]*(?:\\s+${MOT})*`;
const CHAMP = new RegExp(`(?<=\\S)\\s+(?=${LABEL}:\\s)`, "g");
const TITRE_SECTION = new RegExp(`^([A-ZÉÈÀÎÔ][^:]*?)(?=\\s+${LABEL}:\\s|$)`, "s");

export function estEforms(texte: string): boolean {
  return /(?:^|\s)\d\.\s+[A-ZÉ]/.test(texte) && /\b(Nom officiel|Type de procédure|Nature principale du marché)\s*:/.test(texte);
}

function decouperChamps(corps: string): Array<{ label: string; valeur: string }> {
  const champs: Array<{ label: string; valeur: string }> = [];
  for (const morceau of corps.split(CHAMP)) {
    const t = morceau.trim();
    if (!t) continue;
    const m = t.match(/^([^:,]{1,110}):\s*(.*)$/s);
    if (m) champs.push({ label: m[1]!.trim(), valeur: m[2]!.trim() });
    else if (champs.length) champs[champs.length - 1]!.valeur += ` ${t}`;
    else champs.push({ label: "", valeur: t });
  }
  return champs;
}

export function structurerTexte(texte: string): TexteStructure | null {
  if (!estEforms(texte)) return null;
  const parts = texte.split(SECTION);
  // split avec groupe capturant : [avant, numero, reste, numero, reste, …]
  const sections: SectionAvis[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const numero = parts[i]!.replace(/\.$/, "");
    const reste = (parts[i + 1] ?? "").trim();
    const m = reste.match(TITRE_SECTION);
    let titre = m ? m[1]!.trim() : reste.split(/\s+/).slice(0, 4).join(" ");
    let corps = m ? reste.slice(m[0].length) : "";
    // Titre trop long = pas de titre, tout est corps (rare).
    if (titre.length > 60) {
      titre = "";
      corps = reste;
    }
    sections.push({ numero, titre, champs: decouperChamps(corps) });
  }
  if (sections.length === 0) return null;
  const description = sections.flatMap((s) => s.champs).find((c) => /^description$/i.test(c.label));
  return { resume: description?.valeur ?? null, sections };
}
