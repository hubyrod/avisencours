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

// Deux numérotations : eForms (« 1. », « 2.1 », « 5.1.11 ») et l'avis national
// BOAMP (« Section 1 - Identification de l'acheteur »), suivies d'un titre en
// capitale, et pas juste après un « : » (« TVA: 0 Euro » n'est pas une section).
// La numérotation eForms comporte toujours un point (« 1. », « 2.1 ») : « PAPI 3
// Vistre » n'ouvre pas de section.
const SECTION = /(?:^|(?<=[^:\s]\s))(?:Section\s+(\d{1,2})\s*[-–]\s+|(\d{1,2}(?:\.\d{1,2}){1,3}\.?|\d{1,2}\.)\s+)(?=[A-ZÉÈÀÎÔ])/g;
// Libellé de champ eForms : première lettre en capitale, puis des mots en
// minuscules, un sigle court, une parenthèse ou une élision — jamais un autre
// mot capitalisé (« IRCEM agirc-arrco Forme juridique » n'est pas un libellé,
// « Forme juridique de l'acheteur » l'est), jamais de virgule, 72 caractères max.
const MIN = "a-zàâäéèêëîïôöùûüç";
// Un mot capitalisé n'est admis qu'après un tiret (« Code CPV principal - Descripteur principal »).
const MOT = `(?:[${MIN}'’/-]+|[A-ZÉ]{2,5}|\\([^)]*\\)|[ld]'[${MIN}]+|-\\s+[A-ZÉÈÀÎÔ][${MIN}'’/-]*)`;
const LABEL = `(?:N°(?:\\s+[A-ZÉÈÀÎÔ][${MIN}'’/-]*)?|[A-ZÉÈÀÎÔ][${MIN}'’/-]*(?:\\([^)]*\\))?)(?:\\s+${MOT})*`;
// « Libellé: valeur » (eForms) ou « Libellé : valeur » (typographie française).
// Jamais de coupe juste après « N° » ni après un tiret isolé : « N° National
// d'identification » et « Code CPV principal - Descripteur principal » sont un seul libellé.
// Le « : » est suivi d'une espace, ou collé à un nombre (« publication :75 »).
const DEUX_POINTS = `\\s?:(?:\\s|(?=\\d))`;
const CHAMP = new RegExp(`(?<=[^\\s°-])\\s+(?=${LABEL}${DEUX_POINTS})`, "g");
const TITRE_SECTION = new RegExp(`^([A-ZÉÈÀÎÔ][^:]*?)(?=\\s+${LABEL}${DEUX_POINTS}|$)`, "s");
// Section qui commence directement par un champ (« 5.1 Identifiant technique du
// lot : LOT-0001 ») : pas de titre. Titre court de repli : la suite de mots
// qui ressemble à un libellé (« Informations générales » avant « Si la … »).
const CHAMP_EN_TETE = new RegExp(`^${LABEL}${DEUX_POINTS}`);
const TITRE_COURT = new RegExp(`^${LABEL}`);

export function estEforms(texte: string): boolean {
  // Numérotation « 1. » ou « 1.1 » (Marchés Online recopie l'eForms sans le
  // niveau « 1. » : « Section 1 - Acheteur 1.1 Acheteur Nom officiel : … »).
  const numerote = /(?:^|\s)\d{1,2}(?:\.\d{1,2})*\.?\s+[A-ZÉ]/.test(texte) && /\d\./.test(texte);
  const eforms = numerote && /\b(Nom officiel|Type de procédure|Nature principale du marché|Nature du marché)\s*:/.test(texte);
  const national = /\bSection\s+1\s*[-–]\s*(?:Identification|Acheteur)/.test(texte);
  return eforms || national;
}

function decouperChamps(corps: string): Array<{ label: string; valeur: string }> {
  const champs: Array<{ label: string; valeur: string }> = [];
  for (const morceau of corps.split(CHAMP)) {
    const t = morceau.trim();
    if (!t) continue;
    const m = t.match(/^([^:,]{1,110}?)\s?:\s*(.*)$/s);
    if (m) champs.push({ label: m[1]!.trim(), valeur: m[2]!.trim() });
    else if (champs.length) champs[champs.length - 1]!.valeur += ` ${t}`;
    else champs.push({ label: "", valeur: t });
  }
  return champs;
}

function titreEtCorps(reste: string): { titre: string; champs: Array<{ label: string; valeur: string }> } {
  if (CHAMP_EN_TETE.test(reste)) return { titre: "", champs: decouperChamps(reste) };
  const m = reste.match(TITRE_SECTION);
  let titre = m ? m[1]!.trim() : "";
  let corps = m ? reste.slice(m[0].length) : reste;
  // Titre trop long (« Informations générales Si la procédure est annulée… ») :
  // on garde le début qui ressemble à un titre, le reste devient du texte.
  if (!m || titre.length > 60) {
    const c = reste.match(TITRE_COURT);
    titre = c ? c[0] : "";
    corps = reste.slice(titre.length);
  }
  return { titre, champs: decouperChamps(corps) };
}

export function structurerTexte(texte: string): TexteStructure | null {
  if (!estEforms(texte)) return null;
  const parts = texte.split(SECTION);
  // split avec deux groupes capturants : [avant, section, numero, reste, section, numero, reste, …]
  const sections: SectionAvis[] = [];
  // En-tête avant la première section (avis national : « Avis de marché
  // Département(s) de publication : 30 Annonce n° … ») : une section sans numéro.
  const avant = (parts[0] ?? "").trim();
  if (avant) {
    sections.push({ numero: "", ...titreEtCorps(avant) });
  }
  for (let i = 1; i < parts.length; i += 3) {
    const numero = (parts[i] ?? parts[i + 1] ?? "").replace(/\.$/, "");
    const reste = (parts[i + 2] ?? "").trim();
    sections.push({ numero, ...titreEtCorps(reste) });
  }
  if (sections.length === 0) return null;
  const champs = sections.flatMap((s) => s.champs);
  const description =
    champs.find((c) => /^description succincte/i.test(c.label)) ??
    champs.find((c) => /^description$/i.test(c.label)) ??
    champs.find((c) => /^objet du marché/i.test(c.label));
  return { resume: description?.valeur ?? null, sections };
}
