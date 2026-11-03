import type { StoredAnnouncement } from "./db.ts";
import { FAMILLE_LABELS, type Famille } from "./familles.ts";
import { sourceLabel } from "./sources.ts";
import { postWithRetry, DEFAULT_RETRYABLE } from "./http.ts";
import { llmStatsSummary, type LlmStats } from "./llm.ts";
import { phrasesEchec, phrasesIncident, titreIncident, type Incident } from "./incidents.ts";

const API_URL = "https://app.mailpace.com/api/v1/send";

// 403 is deliberately NOT retryable: it means the sending domain is not
// DKIM-verified (or from-domain mismatch) and must surface loudly.
const RETRYABLE = DEFAULT_RETRYABLE;

export type Email = {
  to: string[];
  subject: string;
  html: string;
};

function emailToken(): string | undefined {
  return Bun.env.MAILPACE_API_TOKEN ?? Bun.env.CC_MTA_AUTH_PASSWORD;
}

export function hasEmailToken(): boolean {
  return Boolean(emailToken());
}

export function uniqueEmails(lists: string[][]): string[] {
  return [...new Set(lists.flat().map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

export async function sendEmail(email: Email): Promise<void> {
  const token = emailToken();
  const from = Bun.env.EMAIL_FROM;
  if (!token) throw new Error("MAILPACE_API_TOKEN not set");
  if (!from) throw new Error("EMAIL_FROM not set");

  const body = JSON.stringify({
    from,
    to: email.to.join(","),
    subject: email.subject,
    htmlbody: email.html,
  });

  await postWithRetry(
    "MailPace",
    API_URL,
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "MailPace-Server-Token": token,
      },
      body,
    },
    { retryable: RETRYABLE, attempts: 4 },
  );
}

// Sends the 6-digit login code. Without an email token (local dev), the code
// is printed to stderr instead so the flow stays testable.
export async function sendLoginCode(to: string, code: string): Promise<void> {
  if (!hasEmailToken()) {
    console.error(`[dev] login code for ${to}: ${code}`);
    return;
  }
  await sendEmail({
    to: [to],
    subject: "Votre code de connexion — Avis en cours",
    html: `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#222;">
    <h1 style="font-size:18px;">Code de connexion</h1>
    <p>Votre code de connexion :</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;font-variant-numeric:tabular-nums;">${code}</p>
    <p style="color:#666;">Il expire dans 5 minutes.</p>
    <p style="color:#999;font-size:12px;margin-top:24px;">
      Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
    </p>
  </div>`,
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Provenance hors BOAMP et famille hors mobilité, pour situer l'avis d'un coup d'œil.
function sourceTag(a: StoredAnnouncement): string {
  const parts: string[] = [];
  if (a.publications && a.publications.length > 1) {
    parts.push(`publié sur ${a.publications.map((p) => sourceLabel(p.source)).join(", ")}`);
  } else if (a.source && a.source !== "boamp") parts.push(sourceLabel(a.source));
  if (a.famille && a.famille !== "mobilité") parts.push(FAMILLE_LABELS[a.famille as Famille] ?? a.famille);
  return parts.length ? ` — <span style="color:#0e6b51;">${esc(parts.join(" · "))}</span>` : "";
}

// Statut courant de l'équipe (attachStatuses) : un point coloré et le libellé.
function statusTag(a: StoredAnnouncement): string {
  if (!a.status_label) return "";
  return ` · <span style="white-space:nowrap;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(a.status_color ?? "#626d66")};vertical-align:middle;margin-right:4px;"></span>${esc(a.status_label)}</span>`;
}

// Le titre ouvre la fiche interne (statut, commentaires, texte) quand le
// tableau de bord est connu ; l'annonce officielle reste à un clic.
function itemRow(a: StoredAnnouncement, dashboardUrl: string | null): string {
  const deadline = a.deadline_text ?? "—";
  const fiche = dashboardUrl ? `${dashboardUrl.replace(/\/+$/, "")}/avis/${encodeURIComponent(a.idweb)}` : null;
  const titre = fiche
    ? `<a href="${esc(fiche)}" style="color:#1a5fb4;text-decoration:none;font-weight:600;">${esc(a.objet)}</a> <a href="${esc(a.url)}" style="color:#666;font-size:12px;text-decoration:none;white-space:nowrap;">annonce ↗</a>`
    : `<a href="${esc(a.url)}" style="color:#1a5fb4;text-decoration:none;font-weight:600;">${esc(a.objet)}</a>`;
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">
        ${titre}<br>
        <span style="color:#666;font-size:13px;">${esc(a.acheteur ?? "?")} — dépt. ${esc(a.department || "?")}${sourceTag(a)}${statusTag(a)}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;white-space:nowrap;vertical-align:top;">${esc(deadline)}</td>
    </tr>`;
}

// Keep the email readable: show at most MAX_ROWS per section, point to the
// dashboard for the rest (the first run ever flags thousands as "new").
const MAX_ROWS = 30;

function section(title: string, items: StoredAnnouncement[], emptyText: string, dashboardUrl: string | null): string {
  const shown = items.slice(0, MAX_ROWS);
  const rest = items.length - shown.length;
  const body =
    items.length === 0
      ? `<p style="color:#666;">${emptyText}</p>`
      : `<table style="border-collapse:collapse;width:100%;font-size:14px;">
           <tr>
             <th align="left" style="padding:8px 12px;border-bottom:2px solid #333;">Objet</th>
             <th align="left" style="padding:8px 12px;border-bottom:2px solid #333;">Date limite</th>
           </tr>
           ${shown.map((a) => itemRow(a, dashboardUrl)).join("")}
         </table>` +
        (rest > 0
          ? `<p style="color:#666;font-size:13px;">… et ${rest} autres avis — voir le tableau de bord.</p>`
          : "");
  return `<h2 style="font-size:16px;margin:24px 0 8px;">${title}</h2>${body}`;
}

export type DigestData = {
  newRelevant: StoredAnnouncement[];
  // Échéances proches, telles que lues : les avis au statut « rejet »
  // (abandonnés) en sont retirés ici, l'équipe n'y répondra pas.
  upcoming: StoredAnnouncement[];
  totalRelevant: number;
  totalTravaux: number;
  // Avis pertinents en cours sans aucun statut (countUntriaged) ; absent = non calculé.
  untriaged?: number;
  dashboardUrl: string | null;
  dateStr: string;
  llm?: LlmStats | null;
  // Avertissement technique du run (gardé pour l'alerte administrateur) ; le
  // lecteur reçoit `incident`, sa traduction (src/incidents.ts).
  warning?: string | null;
  incident?: Incident | null;
};

// Encadré ambre : titre + phrases en français courant, même texte que le bandeau du tableau de bord.
export function renderIncidentHtml(i: Incident): string {
  return `<div style="margin:24px 0 0;padding:12px 14px;border-left:4px solid #b5600a;background:#fbf1e3;color:#4a3a1e;font-size:13.5px;">
      <strong>⚠️ ${esc(titreIncident(i))}</strong>
      ${phrasesIncident(i).map((p) => `<p style="margin:6px 0 0;">${esc(p)}</p>`).join("")}
    </div>`;
}

export function upcomingToShow(items: StoredAnnouncement[]): StoredAnnouncement[] {
  return items.filter((a) => !a.status_is_rejet);
}

// The digest is sent every day to opted-in users, whatever the count —
// the subject carries the day's news at a glance.
export function digestSubject(d: DigestData): string {
  const n = d.newRelevant.length;
  if (n === 0) return "Avis en cours — pas de nouvel avis";
  return n === 1 ? "Avis en cours — 1 nouvel avis" : `Avis en cours — ${n} nouveaux avis`;
}

export function renderDigestHtml(d: DigestData): string {
  // Vers les derniers repérés : le tri par défaut du tableau de bord met les
  // avis à trier en tête, pas les nouveaux de l'email.
  const dashboardLink = d.dashboardUrl
    ? `<p><a href="${esc(d.dashboardUrl.replace(/\/+$/, ""))}/?tri=recents" style="color:#1a5fb4;">Voir les derniers avis repérés sur le tableau de bord →</a></p>`
    : "";
  const upcoming = upcomingToShow(d.upcoming);
  const abandonnes = d.upcoming.length - upcoming.length;
  const aTrier =
    d.untriaged !== undefined && d.untriaged > 0
      ? ` <strong>${d.untriaged} sans statut</strong> : ${
          d.dashboardUrl ? `<a href="${esc(d.dashboardUrl)}" style="color:#1a5fb4;">à trier sur le tableau de bord</a>` : "à trier"
        }.`
      : "";
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">
    <h1 style="font-size:20px;">Avis de marchés publics — ${esc(d.dateStr)}</h1>
    <p style="color:#444;">
      ${d.totalRelevant} avis pertinents en cours (${d.totalTravaux} avis travaux, hors scope).${aTrier}
      ${d.newRelevant.length === 0 ? "Aucun nouvel avis pertinent depuis la dernière mise à jour." : ""}
    </p>
    ${section(
      `Nouveaux avis pertinents (${d.newRelevant.length})`,
      d.newRelevant,
      "Aucun nouvel avis aujourd'hui.",
      d.dashboardUrl,
    )}
    ${section(
      `Échéances sous 14 jours (${upcoming.length})`,
      upcoming,
      abandonnes > 0 ? "Aucune échéance à suivre : les avis qui arrivent à échéance ont été abandonnés." : "Aucune échéance dans les 14 prochains jours.",
      d.dashboardUrl,
    )}${abandonnes > 0 && upcoming.length > 0 ? `<p style="color:#666;font-size:13px;">${abandonnes} avis abandonné${abandonnes > 1 ? "s" : ""} non listé${abandonnes > 1 ? "s" : ""}.</p>` : ""}
    ${dashboardLink}
    ${d.incident ? renderIncidentHtml(d.incident) : ""}
    <p style="color:#999;font-size:12px;margin-top:32px;">
      Email automatique quotidien. Si cet email cesse d'arriver, signalez-le à l'administrateur.
      ${d.llm ? `<br>Classification LLM : ${esc(llmStatsSummary(d.llm))}.` : ""}
    </p>
  </div>`;
}

// Avertissement non bloquant : le run a réussi (avis récupérés et stockés)
// mais la classification LLM a été interrompue ou n'a pas pu être utilisée.
// Avertissement non bloquant : coupe-circuit / clé LLM, ou source secondaire
// (achatpublic.com) indisponible. Le texte s'adapte à la cause.
export function renderWarningHtml(warning: string, llm: LlmStats | null | undefined, dateStr: string): string {
  const llmIssue = /LLM|OPENROUTER|coupe-circuit/i.test(warning);
  const sourceIssue = /achatpublic|AFD|Maximilien|AMPA|Marchés Online/i.test(warning);
  const title = llmIssue ? "Classification LLM interrompue" : "Mise à jour partielle";
  const intro = llmIssue
    ? "La mise à jour quotidienne a réussi, mais la classification par modèle de langage n'a pas pu aller au bout : les avis restants ont été classés par les règles regex seules."
    : "La mise à jour quotidienne a réussi, mais une partie de la veille n'a pas pu être faite.";
  const advice = [
    llmIssue ? "Vérifiez la clé et le crédit OpenRouter, puis relancez depuis la page Configuration." : "",
    sourceIssue
      ? "Une source secondaire (achatpublic.com, AFD/dgMarket, Maximilien, AMPA, Marchés Online…) n'a pas répondu (maintenance, panne ou page modifiée) : ses avis n'apparaissent pas comme « en cours » tant qu'un run ne les a pas relus. Relancez plus tard depuis la page Configuration."
      : "",
  ].filter(Boolean);
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">
    <h1 style="font-size:20px;color:#b5600a;">⚠️ ${title} — ${esc(dateStr)}</h1>
    <p>${intro}</p>
    <pre style="background:#f6f6f6;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;">${esc(warning)}</pre>
    ${llm && llmIssue ? `<p style="color:#666;font-size:13px;">Avant l'interruption : ${esc(llmStatsSummary(llm))}.</p>` : ""}
    ${advice.map((a) => `<p style="color:#666;font-size:13px;">${esc(a)}</p>`).join("")}
  </div>`;
}

// Email aux utilisateurs quand la mise à jour a échoué (ils n'ont pas de digest ce jour-là).
export const ECHEC_SUBJECT = "Avis en cours — mise à jour non effectuée";

export function renderEchecHtml(dateStr: string, lastSuccessAt: Date | null, prochaine: string, dashboardUrl: string | null): string {
  const phrases = phrasesEchec(dateStr, lastSuccessAt, prochaine);
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">
    <h1 style="font-size:20px;color:#b5600a;">⚠️ Mise à jour non effectuée — ${esc(dateStr)}</h1>
    ${phrases.map((p) => `<p>${esc(p)}</p>`).join("")}
    ${dashboardUrl ? `<p><a href="${esc(dashboardUrl)}" style="color:#1a5fb4;">Voir les avis sur le tableau de bord →</a></p>` : ""}
    <p style="color:#999;font-size:12px;margin-top:32px;">Email automatique. Le digest quotidien reprendra avec la prochaine mise à jour réussie.</p>
  </div>`;
}

export function renderAlertHtml(error: string, dateStr: string): string {
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">
    <h1 style="font-size:20px;color:#c01c28;">⚠️ Échec de la mise à jour des avis — ${esc(dateStr)}</h1>
    <p>La récupération quotidienne des avis de marchés publics a échoué. Le tableau de bord affiche les données de la dernière exécution réussie.</p>
    <pre style="background:#f6f6f6;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;">${esc(error)}</pre>
  </div>`;
}
