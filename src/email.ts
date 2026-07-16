import type { StoredAnnouncement } from "./db.ts";

const API_URL = "https://api.brevo.com/v3/smtp/email";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

export type Email = {
  to: string[];
  subject: string;
  html: string;
};

export function digestRecipients(): string[] {
  return (Bun.env.DIGEST_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sendEmail(email: Email): Promise<void> {
  const key = Bun.env.BREVO_API_KEY;
  const from = Bun.env.EMAIL_FROM;
  if (!key) throw new Error("BREVO_API_KEY not set");
  if (!from) throw new Error("EMAIL_FROM not set");

  const body = JSON.stringify({
    sender: { email: from, name: "Avis en cours" },
    to: email.to.map((e) => ({ email: e })),
    subject: email.subject,
    htmlContent: email.html,
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body,
    });
    if (res.ok) return;
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function itemRow(a: StoredAnnouncement): string {
  const deadline = a.deadline_text ?? "—";
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">
        <a href="${esc(a.url)}" style="color:#1a5fb4;text-decoration:none;font-weight:600;">${esc(a.objet)}</a><br>
        <span style="color:#666;font-size:13px;">${esc(a.acheteur ?? "?")} — dépt. ${esc(a.department ?? "?")}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;white-space:nowrap;vertical-align:top;">${esc(deadline)}</td>
    </tr>`;
}

// Keep the email readable: show at most MAX_ROWS per section, point to the
// dashboard for the rest (the first run ever flags thousands as "new").
const MAX_ROWS = 30;

function section(title: string, items: StoredAnnouncement[], emptyText: string): string {
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
           ${shown.map(itemRow).join("")}
         </table>` +
        (rest > 0
          ? `<p style="color:#666;font-size:13px;">… et ${rest} autres avis — voir le tableau de bord.</p>`
          : "");
  return `<h2 style="font-size:16px;margin:24px 0 8px;">${title}</h2>${body}`;
}

export type DigestData = {
  newRelevant: StoredAnnouncement[];
  upcoming: StoredAnnouncement[];
  totalRelevant: number;
  totalTravaux: number;
  dashboardUrl: string | null;
  dateStr: string;
};

export function digestSubject(d: DigestData): string {
  const n = d.newRelevant.length;
  if (n === 0) return `Avis en cours — rien de nouveau (${d.totalRelevant} avis suivis)`;
  return n === 1
    ? "Avis en cours — 1 nouvel avis pertinent"
    : `Avis en cours — ${n} nouveaux avis pertinents`;
}

export function renderDigestHtml(d: DigestData): string {
  const dashboardLink = d.dashboardUrl
    ? `<p><a href="${esc(d.dashboardUrl)}" style="color:#1a5fb4;">Voir tous les avis sur le tableau de bord →</a></p>`
    : "";
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#222;">
    <h1 style="font-size:20px;">Avis de marchés publics — ${esc(d.dateStr)}</h1>
    <p style="color:#444;">
      ${d.totalRelevant} avis pertinents en cours (${d.totalTravaux} avis travaux, hors scope).
      ${d.newRelevant.length === 0 ? "Aucun nouvel avis pertinent depuis la dernière mise à jour." : ""}
    </p>
    ${section(
      `Nouveaux avis pertinents (${d.newRelevant.length})`,
      d.newRelevant,
      "Aucun nouvel avis aujourd'hui.",
    )}
    ${section(
      `Échéances sous 14 jours (${d.upcoming.length})`,
      d.upcoming,
      "Aucune échéance dans les 14 prochains jours.",
    )}
    ${dashboardLink}
    <p style="color:#999;font-size:12px;margin-top:32px;">
      Email automatique quotidien. Si cet email cesse d'arriver, signalez-le à l'administrateur.
    </p>
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
