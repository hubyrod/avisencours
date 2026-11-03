// Filtres, tri et comptes du tableau de bord, en mémoire sur les avis en cours
// (quelques milliers de lignes au plus, lues en une requête par `getCurrent`).
// Tout est pur et testable sans base ; la recherche plie accents et casse avec
// le `normalize()` des classifieurs, pour que « vélo », « velo » et « VELO »
// trouvent la même chose.
import { normalize } from "./classify.ts";
import type { StoredAnnouncement } from "./db.ts";

export type TriAvis = "atrier" | "echeance" | "recents";

export type FiltreAvis = {
  // Statut courant (le défaut implicite compte comme statut).
  statusId?: number | null;
  // Masquer les avis au statut « rejet » (abandonnés).
  masquerRejet?: boolean;
  famille?: string | null;
  // Une publication du groupe (principal ou doublon) sur cette source.
  source?: string | null;
  // Mots cherchés (tous requis, dans n'importe quel ordre) dans l'objet,
  // l'acheteur et le département de chaque publication du groupe.
  q?: string | null;
  // Ne garder que les avis apparus après cette date (« nouveaux pour moi »).
  newSince?: Date | null;
};

export function motsRecherche(q: string | null | undefined): string[] {
  return normalize(q ?? "")
    .split(/\s+/)
    .filter((m) => m.length > 0);
}

// Texte dans lequel la recherche cherche : objet, acheteur et département du
// principal et de chacune de ses publications.
function texteCherchable(a: StoredAnnouncement): string {
  const parts: Array<string | null | undefined> = [a.objet, a.acheteur, a.department];
  for (const p of a.publications ?? []) parts.push(p.objet, p.acheteur);
  return normalize(parts.filter((s): s is string => !!s).join(" \n "));
}

export function chercheDans(a: StoredAnnouncement, mots: string[]): boolean {
  if (mots.length === 0) return true;
  const texte = texteCherchable(a);
  return mots.every((m) => texte.includes(m));
}

function surSource(a: StoredAnnouncement, source: string): boolean {
  const pubs = a.publications?.length ? a.publications : [{ source: a.source ?? "boamp" }];
  return pubs.some((p) => p.source === source);
}

// Prédicats un par un, pour pouvoir compter une facette « toutes choses
// égales par ailleurs » (compterFacettes).
type Predicat = (a: StoredAnnouncement) => boolean;

function predicats(f: FiltreAvis): Record<keyof FiltreAvis, Predicat | null> {
  const mots = motsRecherche(f.q);
  const since = f.newSince ? f.newSince.getTime() : null;
  return {
    statusId: f.statusId != null ? (a) => Number(a.status_id) === Number(f.statusId) : null,
    masquerRejet: f.masquerRejet ? (a) => !a.status_is_rejet : null,
    famille: f.famille ? (a) => a.famille === f.famille : null,
    source: f.source ? (a) => surSource(a, f.source!) : null,
    q: mots.length ? (a) => chercheDans(a, mots) : null,
    newSince: since != null ? (a) => !!a.first_seen_at && new Date(a.first_seen_at).getTime() > since : null,
  };
}

function appliquer(items: StoredAnnouncement[], preds: Array<Predicat | null>): StoredAnnouncement[] {
  const actifs = preds.filter((p): p is Predicat => p !== null);
  return actifs.length ? items.filter((a) => actifs.every((p) => p(a))) : items;
}

export function filtrerAvis(items: StoredAnnouncement[], f: FiltreAvis): StoredAnnouncement[] {
  return appliquer(items, Object.values(predicats(f)));
}

// Échéance croissante (sans échéance en dernier) ; « récents » = repérés le
// plus récemment d'abord ; « à trier » = sans événement de statut d'abord
// (les plus récents en tête), puis le reste par échéance.
export function trierAvis(items: StoredAnnouncement[], tri: TriAvis): StoredAnnouncement[] {
  const vu = (a: StoredAnnouncement) => (a.first_seen_at ? new Date(a.first_seen_at).getTime() : 0);
  const echeance = (a: StoredAnnouncement) => (a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER);
  const parEcheance = (x: StoredAnnouncement, y: StoredAnnouncement) =>
    echeance(x) - echeance(y) || x.idweb.localeCompare(y.idweb);
  const parRecence = (x: StoredAnnouncement, y: StoredAnnouncement) => vu(y) - vu(x) || parEcheance(x, y);
  const out = [...items];
  if (tri === "recents") return out.sort(parRecence);
  if (tri === "atrier") {
    // Sans événement de statut = status_set_at null (le statut affiché est le défaut implicite).
    const aTrier = (a: StoredAnnouncement) => (a.status_set_at ? 1 : 0);
    return out.sort((x, y) => aTrier(x) - aTrier(y) || (aTrier(x) === 0 ? parRecence(x, y) : parEcheance(x, y)));
  }
  return out.sort(parEcheance);
}

// Comptes affichés dans les filtres : pour chaque facette, ce que chaque
// valeur donnerait avec les autres filtres tels qu'ils sont. Un groupe publié
// sur deux plateformes compte pour chacune. `rejetMasques` = ce que
// « afficher les abandonnés » ajouterait.
export type Facettes = {
  statut: Map<number, number>;
  source: Map<string, number>;
  famille: Map<string, number>;
  rejetMasques: number;
};

export function compterFacettes(items: StoredAnnouncement[], f: FiltreAvis): Facettes {
  const preds = predicats(f);
  const sauf = (...cles: Array<keyof FiltreAvis>) =>
    appliquer(
      items,
      (Object.keys(preds) as Array<keyof FiltreAvis>).filter((k) => !cles.includes(k)).map((k) => preds[k]),
    );
  // Un statut « rejet » reste proposé avec son compte même quand les
  // abandonnés sont masqués : le choisir les montre (server.ts).
  const statut = new Map<number, number>();
  for (const a of sauf("statusId", "masquerRejet")) {
    if (a.status_id != null) statut.set(Number(a.status_id), (statut.get(Number(a.status_id)) ?? 0) + 1);
  }
  const source = new Map<string, number>();
  for (const a of sauf("source")) {
    const pubs = a.publications?.length ? a.publications : [{ source: a.source ?? "boamp" }];
    for (const s of new Set(pubs.map((p) => p.source))) source.set(s, (source.get(s) ?? 0) + 1);
  }
  const famille = new Map<string, number>();
  for (const a of sauf("famille")) {
    const fam = a.famille ?? "mobilité";
    famille.set(fam, (famille.get(fam) ?? 0) + 1);
  }
  const rejetMasques = f.masquerRejet ? sauf("masquerRejet").filter((a) => !!a.status_is_rejet).length : 0;
  return { statut, source, famille, rejetMasques };
}
