// Historique d'un avis (table avis_events) — logique pure, partagée entre la
// fiche (/avis/:idweb), la page « Activité » et le pipeline, testée dans
// historique.test.ts. Deux familles d'entrées :
// - l'équipe : changement de statut, suppression d'un commentaire ;
// - la veille (le run quotidien) : échéance modifiée, reclassement,
//   rectificatif, publication rattachée ou détachée (doublons).
// L'échappement HTML reste à la charge de l'appelant.

import { frDate } from "./attribution.ts";

export const KINDS_EQUIPE = ["statut", "commentaire-supprime"] as const;
export const KINDS_VEILLE = ["echeance", "categorie", "rectificatif", "doublon"] as const;
export type AvisEventKind = (typeof KINDS_EQUIPE)[number] | (typeof KINDS_VEILLE)[number];

export function estVeille(kind: string): boolean {
  return (KINDS_VEILLE as readonly string[]).includes(kind);
}

// --- Détection des changements faits par la veille --------------------------------

export type AvisEtat = {
  idweb: string;
  deadline_text: string | null;
  category: string;
  type_avis: string | null;
  reason?: string | null;
};

export type Changement = {
  idweb: string;
  kind: AvisEventKind;
  avant: string | null;
  apres: string | null;
  detail: string | null;
};

const CATEGORIES: Record<string, string> = { relevant: "pertinent", travaux: "travaux", excluded: "exclu" };

export function categorieLabel(category: string): string {
  return CATEGORIES[category] ?? category;
}

const blancs = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const estRectificatif = (typeAvis: string | null | undefined) => /rectif/i.test(typeAvis ?? "");

// Ce qui a changé entre la ligne stockée et celle que le run s'apprête à
// écrire. Un avis nouveau (pas de ligne stockée) n'a pas d'historique : c'est
// l'appelant qui ne passe que les avis déjà connus.
export function changementsAvis(avant: AvisEtat, apres: AvisEtat): Changement[] {
  const out: Changement[] = [];
  const dAvant = blancs(avant.deadline_text);
  const dApres = blancs(apres.deadline_text);
  // Une échéance qui disparaît est presque toujours une lecture incomplète de
  // la source, pas une décision de l'acheteur : on ne la journalise pas.
  if (dApres && dAvant !== dApres) {
    out.push({ idweb: apres.idweb, kind: "echeance", avant: dAvant || null, apres: dApres, detail: null });
  }
  if (avant.category !== apres.category) {
    out.push({
      idweb: apres.idweb,
      kind: "categorie",
      avant: categorieLabel(avant.category),
      apres: categorieLabel(apres.category),
      detail: blancs(apres.reason) || null,
    });
  }
  if (!estRectificatif(avant.type_avis) && estRectificatif(apres.type_avis)) {
    out.push({ idweb: apres.idweb, kind: "rectificatif", avant: null, apres: null, detail: null });
  }
  return out;
}

// --- Affichage ---------------------------------------------------------------------

export type HistoriqueEntry = {
  id: number;
  created_at: Date;
  idweb: string;
  kind: string;
  user_id: number | null;
  user_label: string | null;
  status_label: string | null;
  status_color: string | null;
  from_status_label: string | null;
  from_status_color: string | null;
  avant: string | null;
  apres: string | null;
  detail: string | null;
};

export type Pastille = { label: string; color: string };

export type Phrase = {
  qui: string;
  veille: boolean;
  texte: string;
  // Changement de statut : ancien → nouveau, dessinés en pastilles.
  de?: Pastille;
  vers?: Pastille;
  // Complément en petit sous la ligne (motif d'un reclassement).
  precision?: string;
};

const GRIS = "#626d66";

// Auteur d'une entrée : la veille pour les entrées du run ; sinon le nom
// recopié à l'écriture, qui survit à la suppression du compte.
export function auteurHistorique(e: Pick<HistoriqueEntry, "kind" | "user_id" | "user_label">): string {
  if (estVeille(e.kind)) return "La veille";
  if (!e.user_label) return "utilisateur supprimé";
  return e.user_id === null ? `${e.user_label} (compte supprimé)` : e.user_label;
}

export function phraseHistorique(e: HistoriqueEntry): Phrase {
  const base = { qui: auteurHistorique(e), veille: estVeille(e.kind) };
  switch (e.kind) {
    case "statut": {
      const vers = { label: e.status_label ?? "statut supprimé", color: e.status_color ?? GRIS };
      if (!e.from_status_label) return { ...base, texte: "a défini le statut", vers };
      return { ...base, texte: "a changé le statut", de: { label: e.from_status_label, color: e.from_status_color ?? GRIS }, vers };
    }
    case "commentaire-supprime":
      return { ...base, texte: e.detail ?? "a supprimé un commentaire" };
    case "echeance":
      return {
        ...base,
        texte: e.avant ? `Échéance modifiée : ${e.avant} → ${e.apres ?? "?"}` : `Échéance précisée : ${e.apres ?? "?"}`,
      };
    case "categorie":
      return { ...base, texte: `Reclassé : ${e.avant ?? "?"} → ${e.apres ?? "?"}`, precision: e.detail ?? undefined };
    case "rectificatif":
      return { ...base, texte: "Rectificatif publié par l'acheteur" };
    case "doublon":
      return { ...base, texte: e.detail ?? "Publications regroupées" };
    default:
      return { ...base, texte: e.detail ?? e.kind };
  }
}

// Phrase d'une suppression de commentaire, figée à l'écriture (le commentaire
// et son auteur peuvent disparaître ensuite). Le texte du commentaire n'est
// pas conservé : celui qui supprime veut qu'il disparaisse.
export function phraseSuppression(parSonAuteur: boolean, auteur: string | null, ecritLe: Date): string {
  if (parSonAuteur) return `a supprimé son commentaire du ${frDate(ecritLe)}`;
  return `a supprimé un commentaire de ${auteur ?? "un utilisateur supprimé"} du ${frDate(ecritLe)}`;
}

// --- Page « Activité » : regroupement par jour (heure de Paris) ---------------------

const jourCle = (d: Date) => d.toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" }); // aaaa-mm-jj

export function jourLabel(d: Date, now: Date = new Date()): string {
  const cle = jourCle(d);
  if (cle === jourCle(now)) return "Aujourd'hui";
  if (cle === jourCle(new Date(now.getTime() - 86_400_000))) return "Hier";
  return frDate(d);
}

export function grouperParJour<T extends { created_at: Date }>(entries: T[], now: Date = new Date()): Array<{ jour: string; entries: T[] }> {
  const out: Array<{ cle: string; jour: string; entries: T[] }> = [];
  for (const e of entries) {
    const d = new Date(e.created_at);
    const cle = jourCle(d);
    const dernier = out[out.length - 1];
    if (dernier && dernier.cle === cle) dernier.entries.push(e);
    else out.push({ cle, jour: jourLabel(d, now), entries: [e] });
  }
  return out.map(({ jour, entries }) => ({ jour, entries }));
}

export function heureParis(d: Date): string {
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
}
