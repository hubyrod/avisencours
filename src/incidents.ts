// Ce que l'on dit aux utilisateurs quand la veille n'a pas tourné rond :
// une source qui ne répond pas (mise à jour partielle), la classification
// automatique interrompue, ou une mise à jour qui a échoué. Même texte sur le
// tableau de bord et dans les emails. Logique pure, testée dans
// incidents.test.ts ; l'échappement HTML reste à la charge de l'appelant.
import { failedSourcesFromWarning, hasLlmIssue } from "./alertes.ts";
import { sourceLabel } from "./sources.ts";
import { frDate, frDateTime } from "./attribution.ts";
import type { Source } from "./scraper.ts";

export type Panne = {
  source: Source;
  label: string;
  // Début de la panne (premier run réussi de la série qui la signale) ; null = inconnu.
  since: Date | null;
  // Avis pertinents de la source conservés sans relecture ; null = non compté.
  conserves: number | null;
};
export type Incident = { pannes: Panne[]; llm: boolean };
export type PanneInfos = (source: Source) => { since: Date | null; conserves: number | null };

export function incidentFromWarning(warning: string | null | undefined, infos: PanneInfos): Incident | null {
  if (!warning) return null;
  const pannes = failedSourcesFromWarning(warning).map((source) => ({ source, label: sourceLabel(source), ...infos(source) }));
  const llm = hasLlmIssue(warning);
  return pannes.length === 0 && !llm ? null : { pannes, llm };
}

export function titreIncident(i: Incident): string {
  if (i.pannes.length === 0) return "Classification automatique interrompue";
  const noms = i.pannes.map((p) => p.label);
  const liste = noms.length === 1 ? noms[0]! : `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
  return `Mise à jour partielle : ${liste} ne répond${noms.length > 1 ? "ent" : ""} pas`;
}

// Phrases à la suite, pour le lecteur qui n'est pas technicien.
export function phrasesIncident(i: Incident): string[] {
  const out: string[] = [];
  for (const p of i.pannes) {
    const depuis = p.since ? `ne répond pas depuis le ${frDate(p.since)}` : "n'a pas répondu lors de cette mise à jour";
    const gardes =
      p.conserves && p.conserves > 0
        ? ` (${p.conserves} avis pertinent${p.conserves > 1 ? "s" : ""} concerné${p.conserves > 1 ? "s" : ""})`
        : "";
    out.push(
      `Le site ${p.label} ${depuis} : les avis déjà repérés sur ce site restent affichés tels quels, marqués « non revu »${gardes}, mais les nouveaux avis qu'il publie ne sont pas détectés tant que cela dure.`,
    );
  }
  if (i.llm) {
    out.push(
      "La classification automatique a été interrompue : une partie des avis a été classée par les règles simples, des avis « travaux » ou hors sujet peuvent donc apparaître parmi les pertinents jusqu'à la prochaine mise à jour complète.",
    );
  }
  out.push("L'équipe technique est prévenue.");
  return out;
}

// Mise à jour qui a échoué (run en erreur) : rien n'a été relu ce coup-ci.
export function phrasesEchec(dateStr: string, lastSuccessAt: Date | null, prochaine: string): string[] {
  return [
    `La mise à jour des avis du ${dateStr} n'a pas pu être effectuée.`,
    lastSuccessAt
      ? `Les avis affichés sont ceux de la dernière mise à jour réussie, le ${frDateTime(lastSuccessAt)} ; ils restent consultables et leurs statuts modifiables.`
      : "Aucune mise à jour réussie n'est encore disponible.",
    `Une nouvelle tentative aura lieu automatiquement ${prochaine}.`,
    "L'équipe technique est prévenue.",
  ];
}
