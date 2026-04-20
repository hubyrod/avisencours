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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
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
  /\bmaitrise\s+d'?\s*(?:oeuvre|uvre|œuvre)\b/,
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
  { re: /(?:collecte|transport)(?:\s+(?:et|de)\s+\w+){0,3}\s+(?:de\s+)?fonds\b/, label: "transport de fonds" },
  { re: /\bpaiement\s+multicanal\b/, label: "paiement multicanal" },
  { re: /agence\s+de\s+voyages?\b/, label: "agence de voyages" },
  { re: /\bformations?\s+(?:professionnelles?|initiales?|continues?)|insertions?\s+professionnelles?|formation\s+et\s+aide/, label: "formation professionnelle" },
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
  { re: /infrastructures?\s+de\s+recharge|\birve\b|borne(?:s)?\s+irve/, label: "IRVE (recharge)" },
  { re: /demandes?\s+de\s+subvention/, label: "gestion subventions" },
  { re: /gestion\s+(?:du|des|de)\s+(?:service\s+)?(?:du\s+)?stationnement\s+payant/, label: "gestion stationnement opéra." },
  { re: /march[ée]\s+de\s+gestion\s+du\s+service\s+de\s+stationnement/, label: "gestion stationnement opéra." },
  { re: /\binterpretariat\b|interpretation\s+(?:simultanee|consecutive)/, label: "interprétariat" },
  { re: /\bautolaveuse(?:s)?\b/, label: "autolaveuses" },
  { re: /materiels?\s+de\s+sport|equipements?\s+sportifs?/, label: "matériel de sport" },
  { re: /protection\s+contre\s+l'?incendie|securite\s+incendie/, label: "sécurité incendie" },
  { re: /\bgardiennage\b/, label: "gardiennage" },
  { re: /investigations?\s+geotechniques?|investigations?\s+hydrogeologiques?/, label: "investigations géotechniques" },
  { re: /insertion\s+socio[- ]?professionnelle/, label: "insertion socio-professionnelle" },
  { re: /\bbilans?\s+de\s+competences?\b/, label: "bilans de compétences" },
  { re: /eaux?\s+pluviales?|eaux?\s+usees?|eau\s+potable|eaux?\s+brutes?/, label: "eau (pluviales/potable/usées/brutes)" },
  { re: /\bamo\s+ascenseurs?\b|fermetures?\s+automatiques?/, label: "ascenseurs / fermetures auto" },
  { re: /\bcoaching\b/, label: "coaching" },
  { re: /controle\s+exterieur\s+d'?etudes/, label: "contrôle extérieur d'études" },
  { re: /campagne\s+de\s+mesures?\s+bacterio|qualite\s+(?:de\s+l'?|de\s+la\s+)?eau/, label: "mesures qualité eau" },
  { re: /\beffarouchement\b|araignees?\s+de\s+mer/, label: "biodiversité marine" },
  { re: /sortie\s+d'?insalubrite|\bperil\b/, label: "habitat insalubre" },
  { re: /\bsdie\b|schema\s+directeur\s+immobilier/, label: "SDIE / schéma immobilier" },
  { re: /transport\s+et\s+manutention\s+d'?oeuvres/, label: "transport œuvres d'art" },
  { re: /\bbatteries?\s+velo/, label: "batteries vélos (achat)" },
  { re: /bains?\s+de\s+mer|activites?\s+de\s+bains/, label: "bains de mer" },
  { re: /schema\s+directeur.{0,40}d[eé]chets/, label: "schéma déchets" },
  { re: /mobilite\s+verticale/, label: "mobilité verticale (ascenseurs)" },
  { re: /prestations?\s+d'?accueil/, label: "prestations d'accueil" },
  { re: /surveillance\s+(?:de\s+la\s+)?structure/, label: "surveillance bâtiment" },
  { re: /formation\s+sante\s+et\s+securite|conduite\s+en\s+securite/, label: "formation santé/sécurité" },
  { re: /\blignes?\s+regulieres?\b.{0,30}\blots?\b/, label: "transport — lignes régulières" },
  { re: /gestion\s+et\s+exploitation\s+du\s+camping/, label: "concession camping" },
  { re: /signalisation\s+lumineuse\s+tricolore.{0,80}(?:fabrication|pose|depose|fourniture)/, label: "fourniture/pose SLT" },
  { re: /salage\s+(?:et\s+)?(?:de\s+)?deneigement|\bdeneigement\b/, label: "salage / déneigement" },
  { re: /proprete\s+(?:de\s+)?(?:la\s+)?voirie/, label: "propreté voirie" },
  { re: /prise\s+de\s+notes/, label: "prise de notes" },
  { re: /strategie\s+de\s+communication\s+\d/, label: "stratégie de communication" },
  { re: /\bcyclologistique\b|collecte\s+et\s+livraison\s+en\s+cyclo/, label: "cyclologistique (livraison)" },
  { re: /classeurs?\s+rotatifs?/, label: "mobilier de bureau" },
  { re: /billetterie\s+informatisee/, label: "billetterie (piscines, etc.)" },
  { re: /concession.*(?:de\s+)?(?:gestion|exploitation).*aeroport|amo.*concession.*aeroport/, label: "DSP aéroport" },
  { re: /\bfauchage\b/, label: "fauchage / entretien des bords" },
  { re: /execution\s+de\s+services?\s+publics?\s+de\s+transport/, label: "exécution services transport" },
  { re: /ombri[eè]res?\s+(?:pv|photovoltaiques?)|construction.*ombri[eè]res?/, label: "ombrières photovoltaïques" },
  { re: /maintenance\s+(?:multimarque\s+)?(?:des?\s+)?appareils?\s+elevateurs?|maintenance.*escaliers?\s+mecaniques?/, label: "maintenance ascenseurs/escaliers" },
  { re: /concours\s+(?:restreint\s+)?d'?architecture|esquisse\s+restructuration/, label: "concours architecture" },
  { re: /restructuration\s+(?:et\s+extension\s+)?(?:du|de\s+la|d'un|d'une)\s+(?:college|lycee|ecole|groupe\s+scolaire|etablissement\s+scolaire)/, label: "restructuration scolaire" },
  { re: /\bmont\s+saint[- ]michel\b/, label: "Mont Saint-Michel (tourisme)" },
  { re: /entretien\s+(?:des?\s+)?accotements/, label: "entretien accotements" },
  { re: /collecte.{0,40}d[eé]chets/, label: "collecte déchets" },
  { re: /transport\s+par\s+taxi|taxi\s+des\s+(?:enfants|usagers|patients)/, label: "transport par taxi" },
  { re: /\baccueil\s+physique\b/, label: "accueil physique" },
  { re: /concession.*port\s+de\s+plaisance|port\s+de\s+plaisance.*exploitation/, label: "port de plaisance" },
  { re: /\bat\d+\s*[-_].{0,20}(?:transport|tad|lignes?|lots?|scolaire)/i, label: "marché AT* (transport)" },
  { re: /\btad\b.{0,20}\blots?\b|transport\s+a\s+la\s+demande.{0,40}lots?/, label: "TAD (transport opérateur)" },
  { re: /dispositif.*accompagnement.*emploi|travailleurs?\s+beneficiaires|\bboe\b.{0,10}handicap/, label: "accompagnement emploi" },
  { re: /\bbillettique\b|\bnfc\b|systemes?\s+billettiques?/, label: "billettique / NFC" },
  { re: /schema\s+directeur\s+(?:du\s+)?(?:numerique|informatique|ia\b|intelligence\s+artificielle|donnees)/, label: "schéma directeur numérique" },
  { re: /organisation\s+(?:et\s+gestion\s+)?(?:par\s+un\s+implant\s+)?des?\s+deplacements?\s+(?:pour\s+le\s+compte|complexes|nationaux|internationaux|officiels)/, label: "voyages officiels / business travel" },
  { re: /formation\s+(?:de\s+)?prevention\s+des\s+risques/, label: "formation prévention risques" },
  { re: /mobilite\s+internationale\s+des?\s+(?:apprentis|etudiants|stagiaires)|voyages?\s+pour\s+la\s+mobilite\s+internationale/, label: "mobilité internationale étudiants" },
  { re: /lev[eé]s?\s+geotechniques?/, label: "levés géotechniques" },
  { re: /reseaux?\s+radio\b/, label: "réseaux radio (télécom)" },
  { re: /directive\s+cadre\s+(?:sur\s+l'?)?eau|surveillance.*eaux?\s+de\s+surface/, label: "surveillance eaux" },
  { re: /prestations?\s+artistiques?(?:\s+culturelles?)?|evenementiel(?:le)?s?\s+culturel/, label: "prestations culturelles" },
  { re: /transport\s+et\s+(?:hebergement|hotelier)|hebergement\s+hotelier/, label: "transport + hébergement" },
  { re: /exploitation\s+des?\s+installations?\s+thermiques?|installations?\s+thermiques?\s+des\s+batiments/, label: "exploitation thermique" },
  { re: /\bgeometre(?:s)?\s+expert(?:s)?/, label: "géomètre expert" },
  { re: /services?\s+de\s+transports?\s+publics?\s+a\s+la\s+demande|transports?\s+a\s+la\s+demande\s+organis/, label: "TAD opérateur" },
  { re: /maitrise\s+des\s+charges.*eau\s+(?:chaude|froide)/, label: "maîtrise charges eau" },
  { re: /missions?\s+de\s+diagnostics?\s+et\s+de\s+calculs?\s+de\s+structures?|diagnostics?\s+de\s+structures?\s+(?:du|des)\s+batiment/, label: "diagnostic structures (bâtiment)" },
  { re: /gestion\s+de\s+sites?\s+(?:tunnel|viaduc)/, label: "gestion sites tunnel/viaduc" },
  { re: /mise\s+en\s+oeuvre\s+et\s+exploitation\s+d'?un\s+service/, label: "mise en œuvre + exploitation (opérateur)" },
  { re: /\bvtc\b.{0,30}(?:relance|lot|deplacement)/, label: "VTC (ride-hailing)" },
  { re: /(?:entretien|maintenance).{0,20}abris?\s+voyageurs?/, label: "entretien abris voyageurs" },
  { re: /entretien\s+des\s+espaces\s+verts?/, label: "entretien espaces verts" },
  { re: /transports?\s+routiers?\s+de\s+voyageurs|\bcars?\b\s+pour\s+(?:la\s+)?ville/, label: "transport routier voyageurs (bus)" },
  { re: /distributeur(?:s)?\s+automatiques?\s+de\s+titres?|logiciel.*distributeur.*titres?/, label: "distributeur auto. titres" },
  { re: /(?:delegation|concession)\s+(?:de\s+service\s+public\s+)?(?:du|de)\s+stationnement/, label: "DSP stationnement" },
  { re: /(?:mesures?|enquetes?)\s+(?:de\s+)?(?:la\s+)?qualite\s+de\s+service/, label: "mesures qualité service" },
  { re: /savoir\s+rouler\s+a\s+velo|apprentissage.*\bvelo\b/, label: "apprentissage vélo (écoles)" },
  { re: /prestation\s+d'?organisation\s+des?\s+deplacements?/, label: "organisation déplacements (voyages)" },
  { re: /\berasmus\b|mobilite\s+universitaire|mobilite\s+internationale\s+des?\s+etudiants/, label: "mobilité universitaire" },
  { re: /manutention.*port\s+de\s+commerce|tracteurs?\s+a\s+sellettes?/, label: "manutention portuaire" },
  { re: /(?:deplacements?|transports?)\s+des?\s+eleves|\bprestations?\s+de\s+deplacement\b/, label: "transport scolaire / élèves" },
  { re: /velos?\s+(?:a\s+assistance\s+electrique\s+)?en\s+libre[- ]service|\bvls\b/, label: "vélos libre-service (VLS)" },
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
    /\b(?:creation|realisation|construction|renovation|rehabilitation|restructuration|amenagement|requalification|extension|modernisation|refection|mise\s+en\s+conformite)\b/.test(
      objetNorm,
    );
  if (!worksVerb) return false;
  const infraNoun =
    /\b(?:passerelle|pont|ouvrage(?:\s+d'art)?|batiment|voirie|route|gare|carrefour|giratoire|parking|station|quai|equipement|infrastructure|bhns|tramway|metro|liaison|teleo|telepherique)\b/.test(
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
