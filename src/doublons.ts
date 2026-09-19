// Regroupement des publications d'un même appel d'offres paru sur plusieurs
// plateformes (BOAMP + Marchés Online, profil d'acheteur + agrégateur…).
// Logique pure : la base ne connaît que le résultat (announcements.doublon_de
// = idweb du principal ; NULL = principal ou isolé). Règle de rapprochement,
// décidée avec le cabinet : même acheteur (normalisé), même date limite (au
// jour) et intitulés identiques à la ponctuation près ou très proches
// (≥ 85 % de mots communs). Sans date limite, ou départements différents et
// tous deux connus (deux lots régionaux d'un même acheteur) : jamais.
import { normalize } from "./classify.ts";
import type { Source } from "./scraper.ts";

export type Publication = {
  idweb: string;
  objet: string;
  acheteur: string | null;
  department: string | null;
  // Date limite au jour (« dd/mm/yyyy ») ; null = inconnue.
  deadlineDay: string | null;
  source: Source | string;
  firstSeenAt: Date;
  // Principal déjà désigné (valeur en base avant ce regroupement).
  doublonDe: string | null;
  // Commentaires + événements de statut portés par cette ligne.
  activite: number;
};

export type Groupe = { principal: string; doublons: string[] };

const JACCARD_MIN = 0.85;

// Priorité de source quand tout le reste est égal : la publication officielle
// puis les profils d'acheteur, puis les agrégateurs.
const SOURCE_RANG: Record<string, number> = {
  boamp: 0,
  maximilien: 1,
  ampa: 1,
  achatpublic: 2,
  marchesonline: 3,
  afd: 4,
};

// Mots que les plateformes ajoutent ou omettent devant le nom d'une collectivité.
const MOTS_ACHETEUR = /\b(ville|commune|mairie|communaute|cc|ca|cu|metropole|syndicat|mixte|conseil|departemental|regional|departement|region|de|du|des|d|la|le|les|l|et|en|sur|sous)\b/g;

function mots(s: string): string[] {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function acheteurCle(acheteur: string | null): string {
  if (!acheteur) return "";
  // Parenthèses (code postal, ville) et mots outils retirés : « GRAND ANNECY »,
  // « Grand Annecy (74000 - ANNECY) » et « CA du Grand Annecy » convergent.
  const sans = normalize(acheteur).replace(/\([^)]*\)/g, " ").replace(MOTS_ACHETEUR, " ");
  return mots(sans).join(" ");
}

export function objetCle(objet: string): string {
  return mots(objet).join(" ");
}

export function motsObjet(objet: string): Set<string> {
  return new Set(mots(objet).filter((m) => m.length >= 3));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// « 14/10/2026 à 10h00 » / « 14/10/2026 » -> « 14/10/2026 » ; Date -> jour Paris.
export function deadlineDay(deadline: Date | string | null | undefined): string | null {
  if (!deadline) return null;
  if (typeof deadline === "string") {
    const m = deadline.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
  }
  const d = new Date(deadline);
  if (isNaN(d.getTime())) return null;
  const [y, mo, da] = d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }).split("-");
  return `${da}/${mo}/${y}`;
}

function memeAppel(a: Publication, b: Publication): boolean {
  if (a.department && b.department && a.department !== b.department) return false;
  const ka = objetCle(a.objet);
  const kb = objetCle(b.objet);
  if (ka === kb) return true;
  return jaccard(motsObjet(a.objet), motsObjet(b.objet)) >= JACCARD_MIN;
}

function rang(p: Publication): number {
  return SOURCE_RANG[p.source] ?? 9;
}

// Principal d'un groupe, stable dans le temps : un principal déjà désigné vers
// lequel pointe un membre, sinon celui qui porte déjà des statuts/commentaires,
// sinon le plus ancien, sinon la source la plus officielle, sinon l'idweb.
export function choisirPrincipal(membres: Publication[]): Publication {
  const ids = new Set(membres.map((m) => m.idweb));
  const designes = membres.filter((m) => membres.some((x) => x.doublonDe === m.idweb && ids.has(x.idweb)));
  const candidats = designes.length ? designes : membres;
  return [...candidats].sort(
    (x, y) =>
      y.activite - x.activite ||
      x.firstSeenAt.getTime() - y.firstSeenAt.getTime() ||
      rang(x) - rang(y) ||
      x.idweb.localeCompare(y.idweb),
  )[0]!;
}

// Regroupe les publications ; ne renvoie que les groupes d'au moins deux membres.
export function grouperDoublons(pubs: Publication[]): Groupe[] {
  const parCle = new Map<string, Publication[]>();
  for (const p of pubs) {
    if (!p.deadlineDay) continue;
    const cle = `${acheteurCle(p.acheteur)}|${p.deadlineDay}`;
    if (!parCle.has(cle)) parCle.set(cle, []);
    parCle.get(cle)!.push(p);
  }
  const groupes: Groupe[] = [];
  for (const candidats of parCle.values()) {
    if (candidats.length < 2) continue;
    // Composantes connexes de la relation « même appel » (transitive : A~B, B~C ⇒ groupe ABC).
    const reste = [...candidats];
    while (reste.length) {
      const groupe = [reste.shift()!];
      let etendu = true;
      while (etendu) {
        etendu = false;
        for (let i = reste.length - 1; i >= 0; i--) {
          if (groupe.some((g) => memeAppel(g, reste[i]!))) {
            groupe.push(reste.splice(i, 1)[0]!);
            etendu = true;
          }
        }
      }
      if (groupe.length < 2) continue;
      const principal = choisirPrincipal(groupe);
      groupes.push({
        principal: principal.idweb,
        doublons: groupe.filter((g) => g.idweb !== principal.idweb).map((g) => g.idweb),
      });
    }
  }
  return groupes;
}
