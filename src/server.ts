import { timingSafeEqual } from "node:crypto";
import {
  migrate,
  getLastRun,
  getLastSuccessfulRun,
  getCurrent,
  type StoredAnnouncement,
  type RunRow,
} from "./db.ts";

// --- Basic Auth ---------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function checkAuth(req: Request): boolean {
  const user = Bun.env.BASIC_AUTH_USER;
  const pass = Bun.env.BASIC_AUTH_PASS;
  if (!user || !pass) return false;

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), pass);
}

function unauthorized(): Response {
  return new Response("Authentification requise", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Avis en cours", charset="UTF-8"' },
  });
}

// --- Rendering ----------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function frDateTime(d: Date): string {
  return d.toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
}

function deadlineClass(deadline: Date | null): string {
  if (!deadline) return "";
  const days = (deadline.getTime() - Date.now()) / 86_400_000;
  if (days < 7) return "urgent";
  if (days < 14) return "soon";
  return "";
}

function row(a: StoredAnnouncement, latestRunId: number | null): string {
  const isNew = latestRunId !== null && a.first_seen_run_id === latestRunId;
  return `
  <tr>
    <td class="deadline ${deadlineClass(a.deadline)}">${esc(a.deadline_text ?? "—")}</td>
    <td>
      <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.objet)}</a>
      ${isNew ? '<span class="badge">Nouveau</span>' : ""}
      <div class="meta">${esc(a.acheteur ?? "?")} — dépt. ${esc(a.department ?? "?")}${
        a.type_avis ? ` — ${esc(a.type_avis)}` : ""
      }</div>
      ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}
    </td>
    <td class="pub">${esc(a.published_at ?? "?")}</td>
  </tr>`;
}

function banner(lastRun: RunRow | null, lastSuccess: RunRow | null): string {
  if (!lastRun) {
    return `<div class="banner warn">Aucune donnée pour l'instant — la première mise à jour n'a pas encore eu lieu.</div>`;
  }
  if (lastRun.status === "error") {
    const when = lastSuccess?.finished_at ? frDateTime(new Date(lastSuccess.finished_at)) : "jamais";
    return `<div class="banner error">⚠️ La dernière mise à jour a échoué. Données affichées : ${esc(when)}. L'administrateur a été prévenu.</div>`;
  }
  if (lastRun.status === "running") {
    return `<div class="banner warn">Mise à jour en cours…</div>`;
  }
  const when = lastRun.finished_at ? frDateTime(new Date(lastRun.finished_at)) : "?";
  return `<div class="banner ok">Dernière mise à jour : ${esc(when)} — ${lastRun.relevant_count ?? 0} avis pertinents.</div>`;
}

function page(
  cat: "pertinents" | "travaux",
  items: StoredAnnouncement[],
  lastRun: RunRow | null,
  lastSuccess: RunRow | null,
  latestRunId: number | null,
): string {
  const tabs = `
  <nav>
    <a href="/?cat=pertinents" class="${cat === "pertinents" ? "active" : ""}">Avis pertinents (${
      cat === "pertinents" ? items.length : (lastSuccess?.relevant_count ?? "…")
    })</a>
    <a href="/?cat=travaux" class="${cat === "travaux" ? "active" : ""}">Travaux — hors scope</a>
  </nav>`;

  const table =
    items.length === 0
      ? `<p class="empty">Aucun avis en cours dans cette catégorie.</p>`
      : `<table>
          <thead><tr><th>Date limite</th><th>Objet</th><th>Publié le</th></tr></thead>
          <tbody>${items.map((a) => row(a, latestRunId)).join("")}</tbody>
        </table>`;

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Avis en cours — marchés publics mobilité</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; background: #f5f5f4; color: #1c1c1a; }
    header { background: #1c3552; color: #fff; padding: 16px 24px; }
    header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    main { max-width: 1100px; margin: 0 auto; padding: 16px 24px 64px; }
    .banner { padding: 10px 14px; border-radius: 6px; margin: 12px 0; font-size: 14px; }
    .banner.ok { background: #e6f4ea; color: #1e5631; }
    .banner.warn { background: #fef7e0; color: #7a5d00; }
    .banner.error { background: #fce8e6; color: #a50e0e; }
    nav { margin: 16px 0; display: flex; gap: 8px; }
    nav a { padding: 8px 14px; border-radius: 6px; text-decoration: none; color: #1c3552; background: #e7e5e4; font-size: 14px; }
    nav a.active { background: #1c3552; color: #fff; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #78716c; padding: 10px 14px; border-bottom: 2px solid #e7e5e4; }
    td { padding: 12px 14px; border-bottom: 1px solid #f0efee; vertical-align: top; font-size: 14px; }
    td a { color: #1a5fb4; text-decoration: none; font-weight: 600; }
    td a:hover { text-decoration: underline; }
    .meta { color: #78716c; font-size: 13px; margin-top: 2px; }
    .reason { color: #a16207; font-size: 12px; margin-top: 2px; }
    .deadline { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .deadline.urgent { color: #a50e0e; font-weight: 700; }
    .deadline.soon { color: #b45309; font-weight: 600; }
    .pub { white-space: nowrap; color: #78716c; }
    .badge { display: inline-block; background: #1e5631; color: #fff; font-size: 11px; padding: 1px 7px; border-radius: 999px; margin-left: 6px; vertical-align: 2px; }
    .empty { color: #78716c; padding: 32px; text-align: center; background: #fff; border-radius: 8px; }
    footer { color: #a8a29e; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <header><h1>Avis en cours — marchés publics (études de mobilité)</h1></header>
  <main>
    ${banner(lastRun, lastSuccess)}
    ${tabs}
    ${table}
    <footer>Mise à jour automatique chaque matin. Cliquez sur un avis pour ouvrir l'annonce officielle.</footer>
  </main>
</body>
</html>`;
}

function errorPage(msg: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Avis en cours — erreur</title></head>
<body style="font-family:sans-serif;padding:40px;">
<h1>Service indisponible</h1>
<p>Le tableau de bord n'a pas pu charger les données. Réessayez dans quelques minutes ou prévenez l'administrateur.</p>
<pre style="color:#888;font-size:12px;">${esc(msg)}</pre>
</body></html>`;
}

// --- Server -------------------------------------------------------------

async function dashboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cat = url.searchParams.get("cat") === "travaux" ? "travaux" : "pertinents";
  const dbCategory = cat === "travaux" ? "travaux" : "relevant";

  try {
    const [lastRun, lastSuccess] = await Promise.all([getLastRun(), getLastSuccessfulRun()]);
    const items = lastSuccess ? await getCurrent(dbCategory, lastSuccess.id) : [];
    const html = page(cat, items, lastRun, lastSuccess, lastSuccess?.id ?? null);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`dashboard error: ${msg}`);
    return new Response(errorPage(msg), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function health(): Promise<Response> {
  try {
    const lastRun = await getLastRun();
    return Response.json({
      status: "ok",
      lastRun: lastRun
        ? { id: lastRun.id, status: lastRun.status, finishedAt: lastRun.finished_at }
        : null,
    });
  } catch (err) {
    return Response.json(
      { status: "degraded", error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

await migrate().catch((err) => {
  // Boot anyway: the dashboard shows an error page and /sante reports degraded.
  console.error(`migration at startup failed: ${err}`);
});

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  hostname: "0.0.0.0",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/sante" || path === "/health") return health();
    if (!checkAuth(req)) return unauthorized();
    if (path === "/") return dashboard(req);
    return new Response("Page introuvable", { status: 404 });
  },
});

console.error(`dashboard listening on http://${server.hostname}:${server.port}`);
