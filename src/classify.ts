import type { Announcement } from "./scraper.ts";

export type Category = "relevant" | "travaux" | "excluded";

export type Classification = {
  category: Category;
  reason?: string;
};

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .toLowerCase();
}

const EXCLUDE_CONTROLE_TRAVAUX: RegExp[] = [/controle\s+(?:des?\s+)?travaux/];

const EXCLUDE_CONTROLE_QUALITE: RegExp[] = [
  /controle\s+(?:de\s+)?(?:la\s+)?qualite\s+(?:de|du)\s+service/,
];

const EXCLUDE_VRD: RegExp[] = [
  /reperage.{0,40}(?:detection|geo|reseau)/,
  /detection.{0,40}(?:des?\s+)?reseaux/,
  /signalisation\s+lumineuse\s+tricolore/,
  /\bvrd\b/,
  /voirie\s+reseaux\s+divers/,
];

const EXCLUDE_TELECOM: RegExp[] = [
  /\breseau\s+mobile\b/,
  /\btelephonie\b|\btelephonique\b/,
  /\btelephone\s+(?:mobile|portable)\b/,
  /\bsmartphone\b/,
  /\bapplication\s+mobile\b/,
  /\bandroid\b/,
  /\bios\b/,
];

const TRAVAUX: RegExp[] = [
  /\bmaitrise\s+d'\s*oeuvre\b/,
  /\bmoe\b/,
  /\btravaux\b/,
  /\brenovation\b|\brehabilitation\b/,
  /\bisolation\s+(?:acoustique|thermique|phonique)\b/,
  /\bfouilles\s+archeologiques\b/,
  /reconnaissance\s+geotechnique/,
];

const EXCLUDE_HORS_DOMAINE: Array<{ re: RegExp; label: string }> = [
  { re: /\bautocar(?:s)?\b|\bchauffeur(?:s)?\b|\bbus avec chauffeur/, label: "transport operator" },
  { re: /transport\s+scolaire|transports?\s+(?:d['']?enfants|collectifs?\s+d['']?enfants)/, label: "transport scolaire" },
  { re: /location\s+d['e]?\s*(?:autocars?|cars?|minibus|vehicules?)/, label: "location véhicules" },
  { re: /exploitation\s+(?:du|des|de\s+services?)\s+(?:r[ée]seau|service|lignes?|public|du\s+r[ée]seau)/, label: "exploitation réseau/service" },
  { re: /\bdsp\s*\d+\b|conc(?:ession|ede)\s+de\s+service\s+public\s+pour\s+l'exploitation/, label: "DSP exploitation" },
  { re: /\bentretien\s+m[ée]nager\b|\bnettoyage\b|\bbalayage\b/, label: "nettoyage/entretien" },
  { re: /\bmaintenance\s+(?:des?\s+)?(?:[ée]quipements|ascenseurs|applicative|informatique|b[aâ]timents|installations|chauffage)/, label: "maintenance équipements/info" },
  { re: /tierce\s+maintenance\s+applicative|\btma\b/, label: "TMA informatique" },
  { re: /\bassurance(?:s)?\b/, label: "assurance" },
  { re: /titres?\s+restaurant|ch[eè]ques?\s+(?:d[eé]jeuner|cadeau)/, label: "titres restaurant" },
  { re: /collecte\s+(?:et\s+transport\s+)?(?:de\s+)?fonds|transport\s+de\s+fonds/, label: "transport de fonds" },
  { re: /\bpaiement\s+multicanal\b/, label: "paiement multicanal" },
  { re: /agence\s+de\s+voyages/, label: "agence de voyages" },
  { re: /\bformation\s+(?:professionnelle|initiale|continue)|insertion\s+professionnelle|formation\s+et\s+aide/, label: "formation professionnelle" },
  { re: /sensibilisation\s+(?:et|aux|au)/, label: "sensibilisation" },
  { re: /organisme\s+de\s+contr[oô]le\s+technique/, label: "contrôle technique agréé" },
  { re: /sch[ée]ma\s+directeur\s+d'assainissement|assainissement/, label: "assainissement" },
  { re: /vigilance\s+crues|r[ée]f[ée]rentiel\s+de\s+la\s+vigilance/, label: "référentiel hydrométrique" },
  { re: /\bnettoiement\b|collecte\s+(?:et\s+[ée]vacuation\s+)?des?\s+d[ée]chets/, label: "nettoiement / déchets" },
  { re: /transport(?:s)?\s+(?:collectifs?\s+)?de\s+personnes/, label: "transport de personnes" },
  { re: /prestations?\s+de\s+transport(?:s)?\s+(?:collectifs?|scolaires?)/, label: "prestations transport" },
  { re: /transports?\s+collectifs?\s+pour\s+activit[ée]s/, label: "transport scolaire/activité" },
  { re: /exploitation\s+(?:de\s+)?(?:services?\s+(?:de\s+)?)?transports?\s+(?:publics?|collectifs?)/, label: "exploitation transports" },
  { re: /\bmise\s+[aà]\s+disposition\s+(?:et\s+maintenance\s+)?de\s+v[ée]los/, label: "service vélos" },
  { re: /infrastructures?\s+de\s+recharge/, label: "IRVE (infra recharge)" },
  { re: /demandes?\s+de\s+subvention/, label: "gestion subventions" },
  { re: /gestion\s+(?:du|des|de)\s+(?:service\s+)?(?:du\s+)?stationnement\s+payant/, label: "gestion stationnement opéra." },
  { re: /march[ée]\s+de\s+gestion\s+du\s+service\s+de\s+stationnement/, label: "gestion stationnement opéra." },
];

function firstMatch(s: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[0];
  }
  return null;
}

function isAMOForWorks(objetNorm: string): boolean {
  const hasAMO =
    /\bamo\b/.test(objetNorm) ||
    /assistance\s+a\s+maitrise\s+d'\s*ouvrage/.test(objetNorm) ||
    /\bmaitrise\s+d'\s*ouvrage\b/.test(objetNorm);
  if (!hasAMO) return false;
  const worksVerb =
    /\b(?:creation|realisation|construction|renovation|rehabilitation|restructuration|amenagement|requalification|extension|modernisation)\b/.test(
      objetNorm,
    );
  if (!worksVerb) return false;
  const infraNoun =
    /\b(?:passerelle|pont|ouvrage(?:\s+d'art)?|batiment|voirie|route|gare|carrefour|giratoire|parking|station|quai|equipement|infrastructure)\b/.test(
      objetNorm,
    );
  return infraNoun;
}

export function classify(a: Announcement): Classification {
  const objetNorm = normalize(a.objet);
  const hay = normalize(`${a.objet} ${a.typeAvis} ${a.raw}`);

  const ctw = firstMatch(hay, EXCLUDE_CONTROLE_TRAVAUX);
  if (ctw) return { category: "excluded", reason: `contrôle de travaux (« ${ctw} »)` };

  const cq = firstMatch(hay, EXCLUDE_CONTROLE_QUALITE);
  if (cq) return { category: "excluded", reason: `contrôle qualité de service (« ${cq} »)` };

  const tel = firstMatch(hay, EXCLUDE_TELECOM);
  if (tel) return { category: "excluded", reason: `télécom (« ${tel} »)` };

  const vrd = firstMatch(hay, EXCLUDE_VRD);
  if (vrd) return { category: "excluded", reason: `VRD / détection réseaux (« ${vrd} »)` };

  for (const { re, label } of EXCLUDE_HORS_DOMAINE) {
    const m = hay.match(re);
    if (m) return { category: "excluded", reason: `hors domaine — ${label} (« ${m[0]} »)` };
  }

  if (isAMOForWorks(objetNorm)) {
    return { category: "travaux", reason: "AMO pour travaux (création/réalisation d'ouvrage)" };
  }

  const tv = firstMatch(hay, TRAVAUX);
  if (tv) return { category: "travaux", reason: `travaux (« ${tv} »)` };

  return { category: "relevant" };
}
