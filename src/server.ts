import {
  migrate,
  getLastRun,
  getLastSuccessfulRun,
  getCurrent,
  getAnnouncement,
  addComment,
  deleteComment,
  listStatuses,
  getDefaultStatus,
  getStatus,
  addStatus,
  renameStatus,
  setStatusArchived,
  setStatusRejet,
  moveStatus,
  addStatusEvent,
  getCurrentStatusEvent,
  listKeywords,
  addKeyword,
  deleteKeyword,
  listScopeRules,
  addScopeRule,
  deleteScopeRule,
  getSetting,
  setSetting,
  type StoredAnnouncement,
  type RunRow,
  type StatusRow,
  type ScopeRuleRow,
} from "./db.ts";
import { startLive, isLiveReady, liveAdapterState, commentStream } from "./live.ts";
import { frDateTime, statusAttributionLine, statusTooltip } from "./attribution.ts";
import { matchPath } from "./router.ts";
import {
  type AuthUser,
  type UserRow,
  getSession,
  createSession,
  deleteSession,
  sessionSetCookie,
  sessionClearCookie,
  findUserByEmail,
  isEmailDomainAllowed,
  ensureUser,
  allowedDomains,
  isEmailish,
  resolveNewUserEmail,
  createLoginCode,
  verifyLoginCode,
  rateLimit,
  clientIp,
  normalizeEmail,
  seedAdmins,
  cleanupAuth,
  listUsers,
  addUser,
  deleteUser,
  setUserCanConfigure,
  updateProfile,
  deleteAllSessions,
} from "./auth.ts";
import { sendLoginCode } from "./email.ts";
import {
  validateKeyword,
  validateRuleTerm,
  validateDigestWindow,
  validateClassifierMode,
  parseDepartements,
  validateModelChain,
  parseModelChain,
} from "./rules.ts";
import { DEFAULT_LLM_MODELS, RECOMMENDED_MODELS } from "./defaults.ts";
import { llmConfigured, llmStatsSummary, defaultModelChain } from "./llm.ts";
import {
  fetchCatalog,
  fetchKeyCredit,
  suggestions,
  priceLabel,
  creditLabel,
  type CatalogModel,
} from "./openrouter-catalog.ts";

// --- Shared rendering -------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Sérialise pour un <script type="application/json"> : « </ » est échappé pour
// qu'aucune valeur ne puisse fermer la balise script.
function jsonBlob(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Outil de travail : sobre et dense. Vert profond en seule couleur d'accent,
// chiffres en mono (échéances, dates), aucune ressource externe.
const BASE_CSS = `
    :root {
      color-scheme: light;
      --papier: #f6f7f5;
      --carte: #ffffff;
      --encre: #1e2321;
      --encre-2: #626d66;
      --panneau: #0d4a39;
      --panneau-fonce: #093528;
      --vert: #0c5c46;
      --rouge: #b3261e;
      --ambre: #92600c;
      --ligne: #e3e6e2;
      --ligne-forte: #cdd3cd;
      --fonte: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --fonte-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body { font-family: var(--fonte); margin: 0; background: var(--papier); color: var(--encre); line-height: 1.5; }
    header { background: var(--panneau); color: #fff; padding: 9px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }
    .sous-titre { font-size: 13px; font-weight: 400; color: #a9c2b7; margin-left: 8px; }
    .who { display: flex; align-items: center; gap: 14px; font-size: 12.5px; color: #c8d8d0; flex-wrap: wrap; }
    .who a { color: #fff; text-decoration: none; }
    .who a:hover { text-decoration: underline; text-underline-offset: 3px; }
    .who form { margin: 0; }
    .who button { background: none; border: 1px solid rgba(255,255,255,.35); color: #fff; border-radius: 6px; padding: 3px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
    .who button:hover { border-color: #fff; }
    main { max-width: 1180px; margin: 0 auto; padding: 16px 24px 56px; }
    a { color: var(--vert); text-underline-offset: 3px; }
    :focus-visible { outline: 2px solid var(--vert); outline-offset: 2px; }
    .titre-page { font-size: 17px; margin: 14px 0 2px; }
    .retour { font-size: 13px; margin: 4px 0 12px; }
    .banner { padding: 9px 13px; border-radius: 7px; margin: 12px 0; font-size: 13.5px; border: 1px solid transparent; }
    .banner.ok { background: #e9f2ed; color: #114634; border-color: #cfe0d7; }
    .banner.error { background: #faeceb; color: #8c1823; border-color: #ecc8c9; }
    .statut { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; font-size: 13px; color: var(--encre-2); }
    .statut .pastille { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .statut.ok .pastille { background: var(--vert); }
    .statut.warn .pastille { background: var(--ambre); }
    table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--carte); border: 1px solid var(--ligne); border-radius: 8px; overflow: hidden; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; color: var(--encre-2); padding: 8px 12px; border-bottom: 1px solid var(--ligne-forte); background: #fafbfa; }
    td { padding: 10px 12px; border-bottom: 1px solid var(--ligne); vertical-align: top; font-size: 13.5px; }
    tr:last-child td { border-bottom: none; }
    td a { color: var(--vert); text-decoration: none; font-weight: 600; }
    td a:hover { text-decoration: underline; }
    table.facts { border: none; border-radius: 0; }
    table.facts th { background: none; border-bottom: 1px solid var(--ligne); text-transform: none; letter-spacing: 0; font-size: 13px; font-weight: 600; width: 160px; padding: 8px 12px 8px 0; }
    table.facts tr:last-child th, table.facts tr:last-child td { border-bottom: none; }
    input[type=email], input[type=text], textarea { width: 100%; padding: 8px 11px; border: 1px solid var(--ligne-forte); border-radius: 6px; font-size: 14px; font-family: inherit; background: var(--carte); color: var(--encre); }
    input[type=checkbox] { accent-color: var(--panneau); }
    textarea { resize: vertical; min-height: 84px; }
    button.primary { background: var(--panneau); color: #fff; border: none; border-radius: 7px; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: background .12s; }
    button.primary:hover { background: var(--panneau-fonce); }
    button.subtle { background: none; border: none; color: var(--vert); cursor: pointer; font-size: 13px; padding: 0; text-decoration: underline; text-underline-offset: 3px; font-family: inherit; }
    .card { background: var(--carte); border: 1px solid var(--ligne); border-radius: 8px; padding: 24px; max-width: 420px; margin: 48px auto; }
    .card h2 { margin: 0 0 6px; font-size: 15.5px; }
    .card p { color: var(--encre-2); font-size: 13.5px; }
    .card label { display: block; font-size: 13px; color: var(--encre-2); margin: 14px 0 4px; }
    .card .actions { margin-top: 16px; display: flex; align-items: center; gap: 16px; }
    .comment { border-top: 1px solid var(--ligne); padding: 10px 0; }
    .comment-head { display: flex; align-items: baseline; gap: 12px; font-size: 13px; color: var(--encre-2); }
    .comment-head span { font-family: var(--fonte-mono); font-size: 11.5px; }
    .comment-body { margin-top: 3px; font-size: 13.5px; white-space: pre-wrap; }
    .comments-link { color: var(--vert); text-decoration: none; font-weight: 400; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
    .statut-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .statut-btns form { margin: 0; }
    .statut-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--carte); border: 1px solid var(--ligne-forte); border-radius: 999px; padding: 4px 12px; font-size: 13px; cursor: pointer; font-family: inherit; color: var(--encre); }
    .statut-btn:hover { border-color: var(--panneau); }
    .statut-btn.actif { border-color: var(--panneau); background: #e9f2ed; font-weight: 600; }
    .statut-attrib { color: var(--encre-2); font-size: 12.5px; margin: 8px 0 0; }
    .evt-statut { border-top: 1px solid var(--ligne); padding: 8px 0; font-size: 12.5px; color: var(--encre-2); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .evt-statut .quand { font-family: var(--fonte-mono); font-size: 11.5px; }
    footer { color: var(--encre-2); font-size: 12px; margin-top: 20px; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
    @media (max-width: 640px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      th, td { padding: 8px 8px; }
    }
`;

function layout(title: string, headerRight: string, inner: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d4a39">
  <title>${esc(title)}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <header>
    <h1>Avis en cours<span class="sous-titre">Marchés publics — études de mobilité</span></h1>
    ${headerRight}
  </header>
  ${inner}
</body>
</html>`;
}

function whoStrip(user: AuthUser): string {
  return `
  <div class="who">
    <span>Connecté&nbsp;: ${esc(user.name || user.email)}</span>
    <a href="/profil">Mon profil</a>
    ${user.isAdmin || user.canConfigure ? '<a href="/configuration">Configuration</a>' : ""}
    ${user.isAdmin ? '<a href="/admin">Administration</a>' : ""}
    <form method="post" action="/deconnexion"><button>Se déconnecter</button></form>
  </div>`;
}

function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function redirect(location: string, status: 302 | 303, setCookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status, headers });
}

// --- Login pages --------------------------------------------------------------

const MSG_RATE_LIMITED = "Trop de demandes. Patientez quelques minutes puis réessayez.";
const MSG_BAD_CODE = "Code invalide ou expiré. Demandez un nouveau code si besoin.";
const MSG_BAD_EMAIL = "Adresse email invalide.";

function errorLine(error?: string): string {
  return error ? `<div class="banner error">${esc(error)}</div>` : "";
}

function loginStep1(error?: string): string {
  return layout(
    "Connexion — Avis en cours",
    "",
    `<main><div class="card">
      <h2>Connexion</h2>
      <p>Recevez un code de connexion par email.</p>
      ${errorLine(error)}
      <form method="post" action="/connexion/code">
        <label for="email">Adresse email</label>
        <input type="email" id="email" name="email" required autofocus autocomplete="email">
        <div class="actions"><button class="primary" type="submit">Recevoir un code</button></div>
      </form>
    </div></main>`,
  );
}

function loginStep2(email: string, error?: string): string {
  return layout(
    "Connexion — Avis en cours",
    "",
    `<main><div class="card">
      <h2>Code de connexion</h2>
      <p>Si un compte existe pour cette adresse, un code à 6 chiffres vient d'être envoyé.
         Il expire dans 5 minutes.</p>
      ${errorLine(error)}
      <form method="post" action="/connexion/verifier">
        <input type="hidden" name="email" value="${esc(email)}">
        <label for="code">Code reçu par email</label>
        <input type="text" id="code" name="code" required autofocus inputmode="numeric"
               pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
        <div class="actions">
          <button class="primary" type="submit">Se connecter</button>
        </div>
      </form>
      <form method="post" action="/connexion/code" style="margin-top:12px;">
        <input type="hidden" name="email" value="${esc(email)}">
        <button class="subtle" type="submit">Renvoyer un code</button>
      </form>
    </div></main>`,
  );
}

// --- Profile page ------------------------------------------------------------------

function profilePage(user: AuthUser, notice?: { kind: "ok" | "error"; text: string }): Response {
  const banner = notice
    ? `<div class="banner ${notice.kind === "ok" ? "ok" : "error"}">${esc(notice.text)}</div>`
    : "";
  return html(
    layout(
      "Mon profil — Avis en cours",
      whoStrip(user),
      `<main>
      <h2 class="titre-page">Mon profil</h2>
      <p class="retour"><a href="/">← Retour aux avis</a></p>
      ${banner}
      <div class="card" style="margin:16px 0;max-width:520px;">
        <h2>Informations</h2>
        <p>
          Adresse email&nbsp;: <strong>${esc(user.email)}</strong><br>
          Rôle&nbsp;: ${user.isAdmin ? "administrateur" : "utilisateur"}
        </p>
        <form method="post" action="/profil">
          <label for="name">Nom affiché</label>
          <input type="text" id="name" name="name" maxlength="80" value="${esc(user.name ?? "")}"
                 placeholder="Prénom Nom">
          <label style="margin-top:14px;">
            <input type="checkbox" name="digest" value="1" ${user.receiveDigest ? "checked" : ""}>
            Recevoir l'email quotidien des nouveaux avis
          </label>
          <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
        </form>
      </div>
      <div class="card" style="margin:16px 0;max-width:520px;">
        <h2>Sécurité</h2>
        <p>Vous déconnecte de ce navigateur et de tous les autres appareils où une session est ouverte.</p>
        <form method="post" action="/profil/deconnexion-partout">
          <div class="actions"><button class="primary" type="submit">Se déconnecter de tous les appareils</button></div>
        </form>
      </div>
    </main>`,
    ),
  );
}

async function handleProfileUpdate(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { name = "", digest = "" } = await form(req);
  await updateProfile(user.id, name, digest === "1");
  const updated: AuthUser = { ...user, name: name.trim().slice(0, 80) || null, receiveDigest: digest === "1" };
  return profilePage(updated, { kind: "ok", text: "Profil mis à jour." });
}

async function handleLogoutEverywhere(_req: Request, _url: URL, user: AuthUser): Promise<Response> {
  await deleteAllSessions(user.id);
  return redirect("/connexion", 303, sessionClearCookie());
}

// --- Admin page ------------------------------------------------------------------

// Accounts added here live on the allowed domain(s): the form collects only
// the local part. Fallback to a full email input when no domain is configured
// (local dev without ALLOWED_EMAIL_DOMAINS).
function emailField(): string {
  const domains = allowedDomains();
  if (domains.length === 0) {
    return `
          <label for="new-email">Email</label>
          <input type="email" id="new-email" name="email" required>`;
  }
  const suffix =
    domains.length === 1
      ? `<span style="white-space:nowrap;color:var(--encre-2);">@${esc(domains[0]!)}</span>`
      : `<select name="domain" style="padding:10px 6px;border:1px solid var(--ligne-forte);border-radius:7px;font-family:inherit;background:var(--carte);">
           ${domains.map((d) => `<option value="${esc(d)}">@${esc(d)}</option>`).join("")}
         </select>`;
  return `
          <label for="new-local">Email</label>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="text" id="new-local" name="local" required autocomplete="off"
                   placeholder="prenom.nom" style="flex:1;">
            ${suffix}
          </div>`;
}

// Couleurs proposées à la création d'un statut (le libellé sert d'intitulé au <option>).
const STATUS_PALETTE: Array<[string, string]> = [
  ["#626d66", "gris"],
  ["#92600c", "ambre"],
  ["#6b7280", "ardoise"],
  ["#1d4ed8", "bleu"],
  ["#0c5c46", "vert"],
  ["#b3261e", "rouge"],
  ["#7c4a03", "brun"],
  ["#7c3aed", "violet"],
];

function statusAdminRow(s: StatusRow): string {
  const mini = (action: string, extra: string, label: string) => `
    <form method="post" action="/admin/statuts/${action}" style="margin:0;display:inline-block;">
      <input type="hidden" name="id" value="${s.id}">${extra}
      <button class="subtle" type="submit">${label}</button>
    </form>`;
  return `
      <tr>
        <td style="white-space:nowrap;">
          <form method="post" action="/admin/statuts/renommer" style="margin:0;display:flex;align-items:center;gap:8px;">
            <span class="dot" style="background:${esc(s.color)}"></span>
            <input type="hidden" name="id" value="${s.id}">
            <input type="text" name="label" value="${esc(s.label)}" required maxlength="60" style="max-width:220px;">
            <button class="subtle" type="submit">Renommer</button>
          </form>
        </td>
        <td style="white-space:nowrap;">
          ${mini("monter", "", "↑")}
          ${mini("descendre", "", "↓")}
        </td>
        <td>${
          s.is_rejet
            ? `oui — ${mini("rejet", '<input type="hidden" name="valeur" value="0">', "retirer")}`
            : `non — ${mini("rejet", '<input type="hidden" name="valeur" value="1">', "marquer")}`
        }</td>
        <td>${
          s.archived
            ? `oui — ${mini("archiver", '<input type="hidden" name="valeur" value="0">', "restaurer")}`
            : `non — ${mini("archiver", '<input type="hidden" name="valeur" value="1">', "archiver")}`
        }</td>
      </tr>`;
}

async function adminPage(user: AuthUser, error?: string): Promise<Response> {
  const [users, statuts] = await Promise.all([listUsers(), listStatuses(true)]);
  const statusRows = statuts.map(statusAdminRow).join("");
  const configCell = (u: UserRow) => {
    if (u.is_admin) return "oui (admin)";
    const mini = (valeur: string, label: string) => `
      <form method="post" action="/admin/configurer" style="margin:0;display:inline-block;">
        <input type="hidden" name="id" value="${u.id}">
        <input type="hidden" name="valeur" value="${valeur}">
        <button class="subtle" type="submit">${label}</button>
      </form>`;
    return u.can_configure ? `oui — ${mini("0", "retirer")}` : `non — ${mini("1", "autoriser")}`;
  };
  const rows = users
    .map(
      (u) => `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.name ?? "—")}</td>
        <td>${u.is_admin ? "oui" : "non"}</td>
        <td>${configCell(u)}</td>
        <td>${u.last_login_at ? esc(frDateTime(new Date(u.last_login_at))) : "jamais"}</td>
        <td>
          <form method="post" action="/admin/supprimer" style="margin:0;">
            <input type="hidden" name="id" value="${u.id}">
            <button class="subtle" type="submit">Supprimer</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return html(
    layout(
      "Administration — Avis en cours",
      whoStrip(user),
      `<main>
      <h2 class="titre-page">Administration — utilisateurs</h2>
      <p class="retour"><a href="/">← Retour aux avis</a></p>
      ${errorLine(error)}
      <table>
        <thead><tr><th>Email</th><th>Nom</th><th>Admin</th><th>Config</th><th>Dernière connexion</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="card" style="margin:24px 0;max-width:520px;">
        <h2>Ajouter un utilisateur</h2>
        <form method="post" action="/admin/ajouter">
          ${emailField()}
          <label for="new-name">Nom</label>
          <input type="text" id="new-name" name="name">
          <label style="margin-top:14px;">
            <input type="checkbox" name="admin" value="1"> Administrateur
          </label>
          <div class="actions"><button class="primary" type="submit">Ajouter</button></div>
        </form>
      </div>
      <h2 class="titre-page" style="margin-top:32px;">Statuts des avis</h2>
      <p style="color:var(--encre-2);font-size:13.5px;margin:2px 0 12px;">
        Liste proposée sur chaque avis. « Abandon » : les avis à ce statut peuvent être masqués
        sur le tableau de bord. Un statut archivé ne peut plus être choisi mais reste visible
        dans l'historique — les statuts ne se suppriment pas.
      </p>
      <table>
        <thead><tr><th>Libellé</th><th>Ordre</th><th>Abandon</th><th>Archivé</th></tr></thead>
        <tbody>${statusRows}</tbody>
      </table>
      <div class="card" style="margin:24px 0;max-width:520px;">
        <h2>Ajouter un statut</h2>
        <form method="post" action="/admin/statuts/ajouter">
          <label for="statut-label">Libellé</label>
          <input type="text" id="statut-label" name="label" required maxlength="60" placeholder="ex. à relancer">
          <label for="statut-color">Couleur</label>
          <select id="statut-color" name="color" style="padding:10px 6px;border:1px solid var(--ligne-forte);border-radius:7px;font-family:inherit;background:var(--carte);">
            ${STATUS_PALETTE.map(([hex, nom]) => `<option value="${hex}">${esc(nom)}</option>`).join("")}
          </select>
          <div class="actions"><button class="primary" type="submit">Ajouter</button></div>
        </form>
      </div>
      <footer>Les utilisateurs se connectent avec un code reçu par email — aucun mot de passe à gérer.${
        allowedDomains().length > 0
          ? ` Les adresses ${allowedDomains()
              .map((d) => `@${esc(d)}`)
              .join(", ")} peuvent se connecter sans compte préalable (créé à la première connexion).`
          : ""
      }</footer>
    </main>`,
    ),
  );
}

// --- Configuration de la veille -----------------------------------------------------
// Accessible aux admins et aux utilisateurs délégués (users.can_configure).
// Même philosophie que /admin : petites actions POST sans JS, re-rendu avec
// bannière en cas d'erreur, redirection 303 en cas de succès.

// Au-delà de ce délai, un run resté « running » est considéré planté (le verrou
// consultatif Postgres reste la vraie protection contre les runs concurrents).
const RUN_STALE_MS = 15 * 60_000;

function runInFlight(lastRun: RunRow | null): boolean {
  return (
    lastRun !== null &&
    lastRun.status === "running" &&
    Date.now() - new Date(lastRun.started_at).getTime() < RUN_STALE_MS
  );
}

function effectiveClassifierDefault(): string {
  const env = Bun.env.CLASSIFIER;
  return env === "regex" || env === "llm" || env === "hybrid" ? env : "hybrid";
}

const CLASSIFIER_LABELS: Array<[string, string]> = [
  ["hybrid", "hybride (regex puis LLM)"],
  ["regex", "regex seul"],
  ["llm", "LLM seul"],
];

// Colonne announcements.classifier -> libellé (voir Classification.classifier).
function classifierLabel(c: string | null | undefined): string | null {
  if (!c) return null;
  if (c === "regex") return "règles regex";
  if (c === "regle") return "règle personnalisée";
  if (c === "erreur") return "erreur de classification (revue manuelle)";
  return `modèle ${c}`;
}

function llmRunLine(run: RunRow): string {
  const parts: string[] = [];
  if (run.llm_stats) parts.push(` — LLM : ${esc(llmStatsSummary(run.llm_stats))}`);
  if (run.warning) parts.push(`<br><span style="color:var(--ambre);">⚠️ ${esc(run.warning)}</span>`);
  return parts.join("");
}

function ruleList(rules: ScopeRuleRow[], kind: "keep" | "exclude"): string {
  const rows = rules
    .filter((r) => r.kind === kind)
    .map(
      (r) => `
        <li style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <span>${esc(r.term)}</span>
          <form method="post" action="/configuration/regles/supprimer" style="margin:0;">
            <input type="hidden" name="id" value="${r.id}">
            <button class="subtle" type="submit">Supprimer</button>
          </form>
        </li>`,
    )
    .join("");
  return rows
    ? `<ul style="list-style:none;padding:0;margin:8px 0;">${rows}</ul>`
    : `<p style="color:var(--encre-2);font-size:13.5px;">Aucune règle.</p>`;
}

async function configPage(
  user: AuthUser,
  notice?: { kind: "ok" | "error"; text: string },
): Promise<Response> {
  const [keywords, rules, fenetre, classifieur, departements, modeles, lastRun, catalog, credit] =
    await Promise.all([
      listKeywords(),
      listScopeRules(),
      getSetting("digest_window_days"),
      getSetting("classifier_mode"),
      getSetting("code_departements"),
      getSetting("llm_models"),
      getLastRun(),
      fetchCatalog(),
      fetchKeyCredit(),
    ]);

  const banner = notice
    ? `<div class="banner ${notice.kind === "ok" ? "ok" : "error"}">${esc(notice.text)}</div>`
    : "";

  const keywordRows = keywords
    .map(
      (k) => `
      <tr>
        <td>${esc(k.term)}</td>
        <td style="text-align:right;">
          <form method="post" action="/configuration/mots-cles/supprimer" style="margin:0;">
            <input type="hidden" name="id" value="${k.id}">
            <button class="subtle" type="submit">Supprimer</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const running = runInFlight(lastRun);
  const runLine = lastRun
    ? `Dernière mise à jour&nbsp;: ${
        lastRun.status === "running"
          ? `démarrée le ${esc(frDateTime(new Date(lastRun.started_at)))}${running ? " — en cours" : " — semble interrompue"}`
          : `${lastRun.status === "success" ? "réussie" : "échouée"} le ${esc(
              frDateTime(new Date(lastRun.finished_at ?? lastRun.started_at)),
            )}${lastRun.status === "success" ? ` (${lastRun.relevant_count ?? 0} avis pertinents)` : ""}${
              lastRun.status === "success" ? llmRunLine(lastRun) : ""
            }`
      }`
    : "Aucune mise à jour n'a encore été effectuée.";

  const llmBlock = renderLlmSettings(modeles, catalog, credit);

  const defaultMode = effectiveClassifierDefault();
  const modeOptions = CLASSIFIER_LABELS.map(
    ([value, label]) =>
      `<option value="${value}" ${classifieur === value ? "selected" : ""}>${esc(label)}</option>`,
  ).join("");

  return html(
    layout(
      "Configuration — Avis en cours",
      whoStrip(user),
      `<main>
      <h2 class="titre-page">Configuration de la veille</h2>
      <p class="retour"><a href="/">← Retour aux avis</a></p>
      ${banner}
      ${running ? '<meta http-equiv="refresh" content="30">' : ""}

      <div class="card" style="margin:16px 0;max-width:640px;">
        <h2>Mots-clés de recherche</h2>
        <p style="color:var(--encre-2);font-size:13.5px;">
          Un avis est récupéré s'il contient au moins un de ces termes.
          Les expressions de plusieurs mots sont recherchées telles quelles.
          Les modifications s'appliquent à la prochaine mise à jour.
        </p>
        <table>
          <tbody>${keywordRows}</tbody>
        </table>
        <form method="post" action="/configuration/mots-cles/ajouter" style="margin-top:12px;">
          <label for="kw-terme">Nouveau mot-clé</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="kw-terme" name="terme" required maxlength="80"
                   placeholder="ex. covoiturage" style="flex:1;">
            <button class="primary" type="submit">Ajouter</button>
          </div>
        </form>
      </div>

      <div class="card" style="margin:16px 0;max-width:640px;">
        <h2>Règles de tri</h2>
        <p style="color:var(--encre-2);font-size:13.5px;">
          Appliquées avant le classement automatique, en cherchant le terme dans le texte
          de l'avis (majuscules et accents ignorés). Une règle « toujours garder »
          l'emporte sur une règle « toujours exclure ».
        </p>
        <h3 style="margin:12px 0 2px;font-size:14px;">Toujours exclure</h3>
        ${ruleList(rules, "exclude")}
        <h3 style="margin:12px 0 2px;font-size:14px;">Toujours garder</h3>
        ${ruleList(rules, "keep")}
        <form method="post" action="/configuration/regles/ajouter" style="margin-top:12px;">
          <label for="regle-terme">Nouvelle règle</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <select name="kind" style="padding:10px 6px;border:1px solid var(--ligne-forte);border-radius:7px;font-family:inherit;background:var(--carte);">
              <option value="exclude">toujours exclure</option>
              <option value="keep">toujours garder</option>
            </select>
            <input type="text" id="regle-terme" name="terme" required maxlength="120"
                   placeholder="ex. fibre optique" style="flex:1;">
            <button class="primary" type="submit">Ajouter</button>
          </div>
        </form>
      </div>

      <div class="card" style="margin:16px 0;max-width:640px;">
        <h2>Réglages</h2>
        <form method="post" action="/configuration/reglages">
          <label for="reg-fenetre">Fenêtre des échéances dans l'email quotidien (jours)</label>
          <input type="number" id="reg-fenetre" name="fenetre" min="1" max="60"
                 value="${esc(fenetre ?? "")}" placeholder="14 (par défaut)">
          <label for="reg-classifieur" style="margin-top:14px;">Classifieur</label>
          <select id="reg-classifieur" name="classifieur" style="padding:10px 6px;border:1px solid var(--ligne-forte);border-radius:7px;font-family:inherit;background:var(--carte);">
            <option value="">par défaut (${esc(
              CLASSIFIER_LABELS.find(([v]) => v === defaultMode)?.[1] ?? defaultMode,
            )})</option>
            ${modeOptions}
          </select>
          ${llmBlock}
          <label for="reg-departements" style="margin-top:14px;">Codes département (séparés par des virgules)</label>
          <input type="text" id="reg-departements" name="departements"
                 value="${esc(departements ?? "")}" placeholder="vide = toute la France">
          <div class="actions"><button class="primary" type="submit">Enregistrer</button></div>
        </form>
      </div>

      <div class="card" style="margin:16px 0;max-width:640px;">
        <h2>Mise à jour</h2>
        <p>${runLine}</p>
        ${
          running
            ? `<div class="banner ok">Mise à jour en cours… Cette page se rafraîchit automatiquement.</div>
               <div class="actions"><button class="primary" disabled>Relancer maintenant</button></div>`
            : `<p style="color:var(--encre-2);font-size:13.5px;">
                 Lance immédiatement une récupération et un reclassement des avis
                 (environ 3 minutes). Aucun email n'est envoyé lors d'une mise à jour manuelle.
               </p>
               <form method="post" action="/configuration/relancer">
                 <div class="actions"><button class="primary" type="submit">Relancer maintenant</button></div>
               </form>`
        }
      </div>
    </main>`,
    ),
  );
}

async function handleConfigHome(_req: Request, url: URL, user: AuthUser): Promise<Response> {
  const notice = url.searchParams.has("lancee")
    ? { kind: "ok" as const, text: "Mise à jour lancée — comptez environ 3 minutes." }
    : undefined;
  return configPage(user, notice);
}

async function handleKeywordAdd(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { terme = "" } = await form(req);
  const v = validateKeyword(terme);
  if (!v.ok) return configPage(user, { kind: "error", text: v.error });
  const added = await addKeyword(v.value, user.id);
  if (!added) return configPage(user, { kind: "error", text: "Ce mot-clé existe déjà." });
  return redirect("/configuration", 303);
}

async function handleKeywordDelete(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "" } = await form(req);
  const kid = Number(id);
  if (!Number.isInteger(kid)) return configPage(user, { kind: "error", text: "Requête invalide." });
  const deleted = await deleteKeyword(kid);
  if (!deleted) {
    return configPage(user, {
      kind: "error",
      text: "Impossible de supprimer le dernier mot-clé : la liste ne peut pas être vide.",
    });
  }
  return redirect("/configuration", 303);
}

async function handleRuleAdd(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { kind = "", terme = "" } = await form(req);
  if (kind !== "keep" && kind !== "exclude") {
    return configPage(user, { kind: "error", text: "Requête invalide." });
  }
  const v = validateRuleTerm(terme);
  if (!v.ok) return configPage(user, { kind: "error", text: v.error });
  const added = await addScopeRule(kind, v.value, user.id);
  if (!added) return configPage(user, { kind: "error", text: "Cette règle existe déjà." });
  return redirect("/configuration", 303);
}

async function handleRuleDelete(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "" } = await form(req);
  const rid = Number(id);
  if (!Number.isInteger(rid)) return configPage(user, { kind: "error", text: "Requête invalide." });
  await deleteScopeRule(rid);
  return redirect("/configuration", 303);
}

async function handleSettingsUpdate(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { fenetre = "", classifieur = "", departements = "", modeles = "" } = await form(req);

  let windowValue: string | null = null;
  if (fenetre.trim() !== "") {
    const v = validateDigestWindow(fenetre);
    if (!v.ok) return configPage(user, { kind: "error", text: v.error });
    windowValue = v.value;
  }
  let modeValue: string | null = null;
  if (classifieur !== "") {
    const v = validateClassifierMode(classifieur);
    if (!v.ok) return configPage(user, { kind: "error", text: v.error });
    modeValue = v.value;
  }
  const dep = parseDepartements(departements);
  if (!dep.ok) return configPage(user, { kind: "error", text: dep.error });
  let modelsValue: string | null = null;
  let catalogNotice: string | null = null;
  if (modeles.trim() !== "") {
    const v = validateModelChain(modeles);
    if (!v.ok) return configPage(user, { kind: "error", text: v.error });
    // Vérification au catalogue OpenRouter : identifiant connu + mode JSON.
    // Catalogue injoignable = on accepte la saisie syntaxiquement valide.
    const catalog = await fetchCatalog();
    if (catalog) {
      const problem = checkChainAgainstCatalog(parseModelChain(v.value), catalog);
      if (problem) return configPage(user, { kind: "error", text: problem });
    } else {
      catalogNotice = "Catalogue OpenRouter injoignable : modèles enregistrés sans vérification.";
    }
    modelsValue = v.value;
  }

  await setSetting("digest_window_days", windowValue, user.id);
  await setSetting("classifier_mode", modeValue, user.id);
  await setSetting("code_departements", dep.codes.length > 0 ? dep.codes.join(",") : null, user.id);
  await setSetting("llm_models", modelsValue, user.id);
  if (catalogNotice) return configPage(user, { kind: "ok", text: `Réglages enregistrés. ${catalogNotice}` });
  return redirect("/configuration", 303);
}

// Le suffixe :floor / :nitro n'est pas un modèle distinct au catalogue.
function baseModelId(id: string): string {
  return id.replace(/:(?:floor|nitro)$/, "");
}

function checkChainAgainstCatalog(models: string[], catalog: CatalogModel[]): string | null {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  for (const id of models) {
    const m = byId.get(baseModelId(id));
    if (!m) return `Modèle inconnu sur OpenRouter : « ${id} ».`;
    if (!m.json) return `Le modèle « ${id} » ne supporte pas le mode JSON (response_format), requis par le classifieur.`;
  }
  return null;
}

// Bloc « Modèles LLM » du formulaire de réglages : champ + suggestions avec
// prix du jour + crédit restant + avertissement si la clé est absente.
function renderLlmSettings(
  modeles: string | null,
  catalog: CatalogModel[] | null,
  credit: { usage: number; limit: number | null; remaining: number | null } | null,
): string {
  let defaultChain: string[];
  try {
    defaultChain = defaultModelChain();
  } catch {
    defaultChain = [...DEFAULT_LLM_MODELS];
  }
  const current = parseModelChain(modeles);
  const shown = current.length ? current : defaultChain;
  const byId = new Map((catalog ?? []).map((m) => [m.id, m]));
  const chainPrices = shown
    .map((id) => {
      const m = byId.get(baseModelId(id));
      return `<li><code>${esc(id)}</code>${m ? ` — ${esc(priceLabel(m))}` : catalog ? " — <em>inconnu au catalogue</em>" : ""}</li>`;
    })
    .join("");
  const options = catalog
    ? suggestions(catalog, RECOMMENDED_MODELS, 40)
        .map((m) => `<option value="${esc(m.id)}">${esc(m.id)} — ${esc(priceLabel(m))}</option>`)
        .join("")
    : "";
  const keyLine = llmConfigured()
    ? credit
      ? `<p style="color:var(--encre-2);font-size:13.5px;margin:6px 0 0;">Crédit OpenRouter : ${esc(creditLabel(credit))}.</p>`
      : ""
    : `<p style="color:var(--ambre);font-size:13.5px;margin:6px 0 0;">⚠️ LLM indisponible : OPENROUTER_API_KEY absente — les modes « hybride » et « LLM seul » retombent sur les règles regex.</p>`;
  return `
          <label for="reg-modeles" style="margin-top:14px;">Modèles LLM (OpenRouter, ordre de repli, séparés par des virgules)</label>
          <input type="text" id="reg-modeles" name="modeles" list="llm-models-list"
                 value="${esc(modeles ?? "")}" placeholder="${esc(defaultChain.join(", "))} (par défaut)">
          <datalist id="llm-models-list">${options}</datalist>
          <p style="color:var(--encre-2);font-size:13.5px;margin:6px 0 0;">
            Le premier modèle répond ; les suivants prennent le relais en cas de panne, de limite de débit ou de réponse inexploitable.
            Chaque modèle est servi par son fournisseur le moins cher.${catalog ? "" : " <em>Catalogue OpenRouter injoignable : prix non affichés.</em>"}
          </p>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:13.5px;color:var(--encre-2);">${chainPrices}</ul>
          ${keyLine}`;
}

async function handleRelance(_req: Request, _url: URL, user: AuthUser): Promise<Response> {
  if (!rateLimit(`relance:${user.id}`, 2, 600_000)) {
    return configPage(user, {
      kind: "error",
      text: "Trop de relances récentes. Patientez quelques minutes puis réessayez.",
    });
  }
  const lastRun = await getLastRun();
  if (runInFlight(lastRun)) {
    return configPage(user, { kind: "error", text: "Une mise à jour est déjà en cours." });
  }
  // Processus séparé : run.ts termine par process.exit et ne doit jamais
  // charger le moteur Skip du serveur. Pas de digest sur un run manuel.
  Bun.spawn({
    cmd: ["bun", "src/run.ts"],
    env: { ...process.env, SKIP_DIGEST: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  return redirect("/configuration?lancee=1", 303);
}

// --- Avis detail + comments ------------------------------------------------------

// Fil rendu côté client (commentaires + changements de statut interclassés) :
// abonnement SSE au flux Skip (événements init/update, données [[idweb, [fil]]]),
// envoi des formulaires en fetch. DOM construit uniquement via
// createElement/textContent — jamais innerHTML.
const CLIENT_JS = `
(() => {
  const CFG = JSON.parse(document.getElementById("cfg").textContent);
  const fil = document.getElementById("fil");
  const nb = document.getElementById("nb");
  if (!fil || !window.EventSource) return;

  const note = (msg) => {
    const p = document.createElement("p");
    p.style.color = "#78716c";
    p.textContent = msg;
    fil.replaceChildren(p);
  };

  const fmt = (ts) => {
    const d = new Date(ts.replace(" ", "T"));
    if (isNaN(d)) return ts;
    return d.toLocaleString("fr-FR", {
      day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
    });
  };

  const who = (c) => c.user_id === null
    ? "utilisateur supprimé"
    : (c.author_name || c.author_email || "?");

  function renderComment(c) {
    const div = document.createElement("div");
    div.className = "comment";
    const head = document.createElement("div");
    head.className = "comment-head";
    const auteur = document.createElement("strong");
    auteur.textContent = who(c);
    const when = document.createElement("span");
    when.textContent = fmt(c.created_at);
    head.append(auteur, when);
    if (CFG.admin || (c.user_id !== null && Number(c.user_id) === CFG.uid)) {
      const f = document.createElement("form");
      f.method = "post";
      f.action = "/commentaires/supprimer";
      f.dataset.live = "1";
      f.style.margin = "0";
      const hid = (n, v) => {
        const i = document.createElement("input");
        i.type = "hidden"; i.name = n; i.value = v;
        return i;
      };
      const b = document.createElement("button");
      b.className = "subtle"; b.type = "submit"; b.textContent = "Supprimer";
      f.append(hid("id", c.id), hid("idweb", CFG.idweb), b);
      head.append(f);
    }
    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = c.body;
    div.append(head, body);
    return div;
  }

  function renderStatut(c) {
    const div = document.createElement("div");
    div.className = "evt-statut";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = c.status_color || "#626d66";
    const txt = document.createElement("span");
    txt.textContent = who(c) + " a passé l'avis à « " + (c.status_label || "statut supprimé") + " »";
    const when = document.createElement("span");
    when.className = "quand";
    when.textContent = fmt(c.created_at);
    div.append(dot, txt, when);
    return div;
  }

  // Surligne le bouton du statut courant (dernier événement, sinon le défaut) et
  // met à jour la ligne « Défini par … » — tous les onglets ouverts suivent en direct.
  function markStatus(thread) {
    let sid = CFG.defaut;
    let last = null;
    for (const i of thread) if (i.kind === "statut") { sid = i.status_id; last = i; }
    for (const b of document.querySelectorAll(".statut-btn")) {
      b.classList.toggle("actif", sid !== null && b.dataset.sid === String(sid));
    }
    const attrib = document.getElementById("statut-attrib");
    if (attrib && last) {
      attrib.textContent = "Défini par " + who(last) + " le " + fmt(last.created_at);
    }
  }

  function render(thread) {
    nb.textContent = String(thread.filter((i) => i.kind === "comment").length);
    markStatus(thread);
    if (!thread.length) {
      note("Aucun commentaire pour l'instant. Lancez la discussion.");
      return;
    }
    fil.replaceChildren();
    for (const c of thread) {
      fil.append(c.kind === "statut" ? renderStatut(c) : renderComment(c));
    }
  }

  let gotInit = false;
  const apply = (e) => {
    let entries;
    try { entries = JSON.parse(e.data); } catch { return; }
    let seen = false;
    for (const [k, values] of entries) {
      if (k === CFG.idweb) { render(values[0] || []); seen = true; }
    }
    if (e.type === "init") { gotInit = true; if (!seen) render([]); }
  };
  const es = new EventSource(CFG.flux);
  es.addEventListener("init", apply);
  es.addEventListener("update", apply);
  es.onerror = () => { if (!gotInit) note("Commentaires indisponibles pour le moment."); };

  document.addEventListener("submit", async (ev) => {
    const f = ev.target;
    if (!(f instanceof HTMLFormElement) || f.dataset.live !== "1") return;
    ev.preventDefault();
    const err = document.getElementById("fil-erreur");
    err.hidden = true;
    err.textContent = "";
    const res = await fetch(f.action, {
      method: "POST",
      body: new FormData(f),
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (res && res.ok) {
      if (f.id === "form-commenter") f.reset();
    } else {
      let msg = "Erreur réseau — réessayez.";
      if (res) {
        const data = await res.json().catch(() => null);
        msg = (data && data.error) || "Une erreur est survenue.";
      }
      err.textContent = msg;
      err.hidden = false;
    }
  });
})();
`;

async function avisPage(user: AuthUser, idweb: string): Promise<Response> {
  const a = await getAnnouncement(idweb);
  if (!a) return html(errorPage("Avis introuvable"), 404);

  // Statut courant rendu côté serveur : correct même sans moteur Skip (flux 503).
  const [statuts, currentEvent, defaultStatus] = await Promise.all([
    listStatuses(false),
    getCurrentStatusEvent(idweb),
    getDefaultStatus(),
  ]);
  const activeId = currentEvent?.status_id ?? (defaultStatus ? Number(defaultStatus.id) : null);
  const attribution = esc(
    statusAttributionLine(
      currentEvent ? { ...currentEvent, created_at: new Date(currentEvent.created_at) } : null,
    ),
  );
  const statusButtons = statuts
    .map(
      (s) => `
        <form method="post" action="/avis/${encodeURIComponent(idweb)}/statut" data-live="1">
          <input type="hidden" name="statut" value="${s.id}">
          <button type="submit" class="statut-btn${Number(s.id) === activeId ? " actif" : ""}" data-sid="${s.id}">
            <span class="dot" style="background:${esc(s.color)}"></span>${esc(s.label)}
          </button>
        </form>`,
    )
    .join("");

  const facts: Array<[string, string | null]> = [
    ["Acheteur", a.acheteur],
    ["Département", a.department],
    ["Date limite", a.deadline_text],
    ["Publié le", a.published_at],
    ["Type d'avis", a.type_avis],
    ["Procédure", a.procedure],
    ["Classement", a.reason],
    ["Classé par", classifierLabel(a.classifier)],
  ];
  const factRows = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v!)}</td></tr>`)
    .join("");

  return html(
    layout(
      `${a.objet} — Avis en cours`,
      whoStrip(user),
      `<main>
      <p class="retour"><a href="/">← Retour aux avis</a></p>
      <div class="card" style="max-width:none;margin:16px 0;">
        <h2>${esc(a.objet)}</h2>
        <table class="facts">${factRows}</table>
        <p style="margin-top:14px;"><a href="${esc(a.url)}" target="_blank" rel="noopener" style="font-weight:600;">Voir l'annonce officielle →</a></p>
      </div>
      ${
        statuts.length > 0
          ? `<div class="card" style="max-width:none;margin:16px 0;">
        <h2>Statut</h2>
        <p style="margin:2px 0 0;">Où en est-on sur cet avis ? Le changement est visible par toute l'équipe et tracé dans le fil.</p>
        <div class="statut-btns">${statusButtons}</div>
        <p class="statut-attrib" id="statut-attrib">${attribution}</p>
      </div>`
          : ""
      }
      <div class="card" style="max-width:none;margin:16px 0;">
        <h2>Commentaires (<span id="nb">…</span>)</h2>
        <div id="fil"><p style="color:#78716c;">Chargement des commentaires…</p></div>
        <div id="fil-erreur" class="banner error" aria-live="polite" hidden></div>
        <form id="form-commenter" data-live="1" method="post"
              action="/avis/${encodeURIComponent(idweb)}/commenter" style="margin-top:16px;">
          <label for="body">Ajouter un commentaire</label>
          <textarea id="body" name="body" required maxlength="4000"
                    placeholder="Votre analyse, une question, une décision…"></textarea>
          <div class="actions"><button class="primary" type="submit">Publier</button></div>
        </form>
        <noscript><p style="color:#78716c;">Les commentaires nécessitent JavaScript.</p></noscript>
      </div>
      <script type="application/json" id="cfg">${jsonBlob({
        uid: user.id,
        admin: user.isAdmin,
        idweb,
        flux: `/avis/${encodeURIComponent(idweb)}/commentaires/flux`,
        defaut: defaultStatus ? String(defaultStatus.id) : null,
      })}</script>
      <script>${CLIENT_JS}</script>
    </main>`,
    ),
  );
}

async function handleAddComment(
  req: Request,
  _url: URL,
  user: AuthUser,
  params: Record<string, string>,
): Promise<Response> {
  const idweb = params.idweb ?? "";
  const a = await getAnnouncement(idweb);
  if (!a) return Response.json({ error: "Avis introuvable." }, { status: 404 });

  if (!rateLimit(`comment:${user.id}`, 20, 600_000)) {
    return Response.json({ error: MSG_RATE_LIMITED }, { status: 429 });
  }
  const { body = "" } = await form(req);
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 4000) {
    return Response.json(
      { error: "Le commentaire est vide ou trop long (4000 caractères max)." },
      { status: 400 },
    );
  }
  await addComment(idweb, user.id, trimmed);
  return Response.json({ ok: true });
}

async function handleSetStatus(
  req: Request,
  _url: URL,
  user: AuthUser,
  params: Record<string, string>,
): Promise<Response> {
  const idweb = params.idweb ?? "";
  const a = await getAnnouncement(idweb);
  if (!a) return Response.json({ error: "Avis introuvable." }, { status: 404 });

  if (!rateLimit(`statut:${user.id}`, 30, 600_000)) {
    return Response.json({ error: MSG_RATE_LIMITED }, { status: 429 });
  }
  const { statut = "" } = await form(req);
  const statusId = Number(statut);
  if (!Number.isInteger(statusId)) return Response.json({ error: "Requête invalide." }, { status: 400 });
  const s = await getStatus(statusId);
  if (!s || s.archived) {
    return Response.json({ error: "Statut inconnu ou archivé." }, { status: 400 });
  }
  // Re-clic sur le statut déjà affiché (dernier événement, sinon le défaut) :
  // pas de nouvel événement, le fil resterait sinon pollué de doublons.
  const current =
    (await getCurrentStatusEvent(idweb))?.status_id ?? Number((await getDefaultStatus())?.id ?? NaN);
  if (current === statusId) return Response.json({ ok: true });
  await addStatusEvent(idweb, statusId, user.id);
  return Response.json({ ok: true });
}

async function handleDeleteComment(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "" } = await form(req);
  const commentId = Number(id);
  if (!Number.isInteger(commentId)) {
    return Response.json({ error: "Requête invalide." }, { status: 400 });
  }
  await deleteComment(commentId, user.id, user.isAdmin);
  return Response.json({ ok: true });
}

// --- Dashboard ----------------------------------------------------------------------

// Calendar days (Europe/Paris) between today and the deadline: J−0 = last day.
function joursRestants(deadline: Date | null): number | null {
  if (!deadline) return null;
  const jour = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  const diff = new Date(jour(deadline)).getTime() - new Date(jour(new Date())).getTime();
  return Math.max(0, Math.round(diff / 86_400_000));
}

function jChip(deadline: Date | null): string {
  const j = joursRestants(deadline);
  if (j === null) return `<span class="jrest none">—</span>`;
  const urgence = j < 7 ? "urgent" : j < 14 ? "soon" : "";
  return `<span class="jrest ${urgence}">J−${j}</span>`;
}

function announcementRow(a: StoredAnnouncement, latestRunId: number | null): string {
  const isNew = latestRunId !== null && a.first_seen_run_id === latestRunId;
  const tooltip = statusTooltip(
    a.status_set_at
      ? {
          user_id: a.status_set_by_id == null ? null : Number(a.status_set_by_id),
          author_name: a.status_set_by_name ?? null,
          author_email: a.status_set_by_email ?? null,
          created_at: new Date(a.status_set_at),
        }
      : null,
  );
  // Le title reprend toujours le libellé : en mobile seul le point coloré est visible.
  const statusTitle = a.status_label
    ? ` title="${esc(tooltip ? `${a.status_label} — ${tooltip}` : a.status_label)}"`
    : "";
  const statusBadge = a.status_label
    ? `<span class="badge-statut"${statusTitle}><span class="dot" style="background:${esc(
        a.status_color ?? "#626d66",
      )}"></span><span class="lbl">${esc(a.status_label)}</span></span>`
    : `<span class="jrest none">—</span>`;
  return `
  <tr>
    <td class="deadline">${jChip(a.deadline)}${
      a.deadline_text ? `<div class="jdate">${esc(a.deadline_text)}</div>` : ""
    }</td>
    <td>
      <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.objet)}</a>
      ${isNew ? '<span class="badge">Nouveau</span>' : ""}
      <div class="meta">${esc(a.acheteur ?? "?")} — dépt. ${esc(a.department ?? "?")}${
        a.type_avis ? ` — ${esc(a.type_avis)}` : ""
      }${
        a.published_at ? ` — publié le ${esc(a.published_at)}` : ""
      } — <a class="comments-link" href="/avis/${encodeURIComponent(a.idweb)}">${
        (a.comment_count ?? 0) > 0 ? `Commentaires (${a.comment_count})` : "Commenter"
      }</a></div>
      ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}
    </td>
    <td class="statut-col">${statusBadge}</td>
  </tr>`;
}

function banner(lastRun: RunRow | null, lastSuccess: RunRow | null): string {
  if (!lastRun) {
    return `<div class="statut warn"><span class="pastille"></span>Aucune donnée pour l'instant — la première mise à jour n'a pas encore eu lieu.</div>`;
  }
  if (lastRun.status === "error") {
    const when = lastSuccess?.finished_at ? frDateTime(new Date(lastSuccess.finished_at)) : "jamais";
    return `<div class="banner error">⚠️ La dernière mise à jour a échoué. Données affichées : ${esc(when)}. L'administrateur a été prévenu.</div>`;
  }
  if (lastRun.status === "running") {
    return `<div class="statut warn"><span class="pastille"></span>Mise à jour en cours…</div>`;
  }
  const when = lastRun.finished_at ? frDateTime(new Date(lastRun.finished_at)) : "?";
  return `<div class="statut ok"><span class="pastille"></span>Dernière mise à jour : ${esc(when)} — ${lastRun.relevant_count ?? 0} avis pertinents.</div>`;
}

const DASHBOARD_CSS = `
    nav { margin: 10px 0 14px; display: flex; gap: 22px; border-bottom: 1px solid var(--ligne-forte); }
    nav a { padding: 8px 2px 9px; margin-bottom: -1px; text-decoration: none; font-size: 13.5px; font-weight: 500; color: var(--encre-2); border-bottom: 2px solid transparent; }
    nav a:hover { color: var(--encre); }
    nav a.active { color: var(--encre); font-weight: 600; border-bottom-color: var(--panneau); }
    tbody tr:hover td { background: #f7faf8; }
    .meta { color: var(--encre-2); font-size: 12.5px; margin-top: 2px; }
    .reason { color: var(--ambre); font-size: 12px; margin-top: 2px; }
    .deadline { white-space: nowrap; width: 118px; }
    .jrest { font-family: var(--fonte-mono); font-weight: 600; font-size: 13px; }
    .jrest.soon { color: var(--ambre); }
    .jrest.urgent { color: var(--rouge); }
    .jrest.none { color: var(--encre-2); font-weight: 400; }
    .jdate { font-family: var(--fonte-mono); font-size: 11px; color: var(--encre-2); margin-top: 3px; }
    .statut-col { width: 1%; white-space: nowrap; }
    .badge { display: inline-block; background: #e5efe9; color: var(--vert); font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 4px; margin-left: 7px; vertical-align: 1px; }
    .badge-statut { display: inline-flex; align-items: center; gap: 5px; background: #f1f3f0; border: 1px solid var(--ligne); color: var(--encre-2); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .filtres { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; font-size: 13px; color: var(--encre-2); flex-wrap: wrap; }
    .filtres select { padding: 5px 8px; border: 1px solid var(--ligne-forte); border-radius: 6px; font-family: inherit; background: var(--carte); font-size: 13px; color: var(--encre); }
    .filtres label { display: flex; align-items: center; gap: 6px; }
    .filtres button { background: var(--carte); border: 1px solid var(--ligne-forte); border-radius: 6px; padding: 4px 12px; font-size: 13px; cursor: pointer; font-family: inherit; color: var(--encre); }
    .filtres button:hover { border-color: var(--panneau); }
    .empty { color: var(--encre-2); padding: 32px; text-align: center; background: var(--carte); border: 1px solid var(--ligne); border-radius: 8px; font-size: 13.5px; }
    @media (max-width: 640px) { .deadline { width: 88px; } .jdate { white-space: normal; } .badge-statut { padding: 2px 5px; } .badge-statut .lbl { display: none; } }
`;

async function dashboard(req: Request, url: URL, user: AuthUser): Promise<Response> {
  const cat = url.searchParams.get("cat") === "travaux" ? "travaux" : "pertinents";
  const dbCategory = cat === "travaux" ? "travaux" : "relevant";
  const statutParam = Number(url.searchParams.get("statut"));
  const statusId = Number.isInteger(statutParam) && statutParam > 0 ? statutParam : null;
  const masquer = url.searchParams.get("masquer") === "1";

  const [lastRun, lastSuccess, statuts] = await Promise.all([
    getLastRun(),
    getLastSuccessfulRun(),
    listStatuses(false),
  ]);
  const items = lastSuccess
    ? await getCurrent(dbCategory, lastSuccess.id, { statusId, hideRejet: masquer })
    : [];
  const latestRunId = lastSuccess?.id ?? null;

  const tabs = `
  <nav>
    <a href="/?cat=pertinents" class="${cat === "pertinents" ? "active" : ""}">Avis pertinents (${
      cat === "pertinents" ? items.length : (lastSuccess?.relevant_count ?? "…")
    })</a>
    <a href="/?cat=travaux" class="${cat === "travaux" ? "active" : ""}">Travaux — hors scope</a>
  </nav>`;

  const filtres =
    statuts.length === 0
      ? ""
      : `
  <form class="filtres" method="get" action="/">
    <input type="hidden" name="cat" value="${cat}">
    <label for="f-statut">Statut</label>
    <select id="f-statut" name="statut">
      <option value="">Tous</option>
      ${statuts
        .map(
          (s) =>
            `<option value="${s.id}"${Number(s.id) === statusId ? " selected" : ""}>${esc(s.label)}</option>`,
        )
        .join("")}
    </select>
    <label><input type="checkbox" name="masquer" value="1"${masquer ? " checked" : ""}> Masquer les avis abandonnés</label>
    <button type="submit">Filtrer</button>
  </form>`;

  const table =
    items.length === 0
      ? `<p class="empty">${
          statusId !== null || masquer
            ? "Aucun avis ne correspond à ce filtre."
            : "Aucun avis en cours dans cette catégorie."
        }</p>`
      : `<table>
          <thead><tr><th>Échéance</th><th>Objet</th><th>Statut</th></tr></thead>
          <tbody>${items.map((a) => announcementRow(a, latestRunId)).join("")}</tbody>
        </table>`;

  const body = `
  <style>${DASHBOARD_CSS}</style>
  <main>
    ${banner(lastRun, lastSuccess)}
    ${tabs}
    ${filtres}
    ${table}
    <footer>Mise à jour automatique chaque matin. Cliquez sur un avis pour ouvrir l'annonce officielle.</footer>
  </main>`;

  return html(layout("Avis en cours — marchés publics mobilité", whoStrip(user), body));
}

function errorPage(msg: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Avis en cours — erreur</title></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#f6f7f5;color:#1e2321;padding:40px 24px;margin:0;">
<div style="max-width:520px;margin:48px auto;background:#fff;border:1px solid #e3e6e2;border-radius:8px;padding:24px;">
<h1 style="font-size:18px;margin:0 0 8px;">Service indisponible</h1>
<p style="color:#5d6a62;font-size:14px;">La page n'a pas pu charger. Réessayez dans quelques minutes ou prévenez l'administrateur.</p>
<pre style="color:#5d6a62;font-size:12px;white-space:pre-wrap;">${esc(msg)}</pre>
<p style="font-size:14px;"><a href="/" style="color:#0e6b51;">← Retour aux avis</a></p>
</div>
</body></html>`;
}

// --- Auth route handlers -----------------------------------------------------------

async function form(req: Request): Promise<Record<string, string>> {
  const data = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of data.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

async function handleLoginPage(_req: Request, _url: URL, user: AuthUser | null): Promise<Response> {
  if (user) return redirect("/", 302);
  return html(loginStep1());
}

async function handleRequestCode(req: Request): Promise<Response> {
  const { email = "" } = await form(req);
  const norm = normalizeEmail(email);
  if (!isEmailish(norm)) return html(loginStep1(MSG_BAD_EMAIL), 400);

  const ipOk = rateLimit(`codeip:${clientIp(req)}`, 10, 600_000);
  const emailOk = rateLimit(`code:${norm}`, 3, 600_000);
  if (!ipOk || !emailOk) return html(loginStep1(MSG_RATE_LIMITED), 429);

  const user = await findUserByEmail(norm);
  if (user || isEmailDomainAllowed(norm)) {
    const code = await createLoginCode(norm);
    if (code) {
      // Fire-and-forget: awaiting the send would leak account existence via timing.
      sendLoginCode(norm, code).catch((err) =>
        console.error(`login code email failed for ${norm}: ${err}`),
      );
    }
  }
  return html(loginStep2(norm));
}

async function handleVerifyCode(req: Request): Promise<Response> {
  const { email = "", code = "" } = await form(req);
  const norm = normalizeEmail(email);

  if (!rateLimit(`verify:${clientIp(req)}`, 20, 600_000)) {
    return html(loginStep2(norm, MSG_RATE_LIMITED), 429);
  }

  const ok = norm && code ? await verifyLoginCode(norm, code) : false;
  if (!ok) return html(loginStep2(norm, MSG_BAD_CODE), 401);

  // Allowed-domain emails are provisioned at first successful login.
  let user = await findUserByEmail(norm);
  if (!user && isEmailDomainAllowed(norm)) user = await ensureUser(norm);
  if (!user) return html(loginStep2(norm, MSG_BAD_CODE), 401);

  const token = await createSession(user.id);
  cleanupAuth().catch(() => {});
  return redirect("/", 303, sessionSetCookie(token));
}

async function handleLogout(req: Request): Promise<Response> {
  await deleteSession(req);
  return redirect("/connexion", 303, sessionClearCookie());
}

async function handleAdminAdd(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { email = "", local = "", domain = "", name = "", admin = "" } = await form(req);
  const fullEmail = resolveNewUserEmail({ email, local, domain });
  if (!fullEmail) return adminPage(user, MSG_BAD_EMAIL);
  const created = await addUser(fullEmail, name, admin === "1");
  if (!created) return adminPage(user, "Cet utilisateur existe déjà.");
  return redirect("/admin", 303);
}

async function handleAdminDelete(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "" } = await form(req);
  const targetId = Number(id);
  if (!Number.isInteger(targetId)) return adminPage(user, "Requête invalide.");
  if (targetId === user.id) {
    return adminPage(user, "Impossible de supprimer votre propre compte.");
  }
  await deleteUser(targetId);
  return redirect("/admin", 303);
}

// Délégation de l'accès à /configuration (colonne « Config » du tableau).
async function handleAdminConfigure(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "", valeur = "" } = await form(req);
  const targetId = Number(id);
  if (!Number.isInteger(targetId)) return adminPage(user, "Requête invalide.");
  await setUserCanConfigure(targetId, valeur === "1");
  return redirect("/admin", 303);
}

// --- Admin : statuts d'avis ---------------------------------------------------------

async function handleAdminStatusAdd(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { label = "", color = "" } = await form(req);
  const trimmed = label.trim().slice(0, 60);
  if (!trimmed) return adminPage(user, "Le libellé du statut est requis.");
  if (!/^#[0-9a-f]{6}$/.test(color)) return adminPage(user, "Couleur invalide.");
  await addStatus(trimmed, color);
  return redirect("/admin", 303);
}

// Les autres actions partagent la même forme : un id + éventuellement une valeur.
async function handleAdminStatusAction(
  req: Request,
  user: AuthUser,
  action: "renommer" | "monter" | "descendre" | "archiver" | "rejet",
): Promise<Response> {
  const { id = "", label = "", valeur = "" } = await form(req);
  const statusId = Number(id);
  if (!Number.isInteger(statusId)) return adminPage(user, "Requête invalide.");
  switch (action) {
    case "renommer": {
      const trimmed = label.trim().slice(0, 60);
      if (!trimmed) return adminPage(user, "Le libellé du statut est requis.");
      await renameStatus(statusId, trimmed);
      break;
    }
    case "monter":
      await moveStatus(statusId, "up");
      break;
    case "descendre":
      await moveStatus(statusId, "down");
      break;
    case "archiver":
      await setStatusArchived(statusId, valeur === "1");
      break;
    case "rejet":
      await setStatusRejet(statusId, valeur === "1");
      break;
  }
  return redirect("/admin", 303);
}

// --- Health -----------------------------------------------------------------------

async function health(): Promise<Response> {
  try {
    const lastRun = await getLastRun();
    return Response.json({
      status: "ok",
      live: isLiveReady(),
      livePg: liveAdapterState(),
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

// --- Router -----------------------------------------------------------------------

type Access = "public" | "user" | "config" | "admin";
type Handler = (
  req: Request,
  url: URL,
  user: AuthUser | null,
  params: Record<string, string>,
) => Promise<Response>;

const routes: Array<{ method: string; path: string; access: Access; handler: Handler }> = [
  { method: "GET", path: "/sante", access: "public", handler: () => health() },
  { method: "GET", path: "/health", access: "public", handler: () => health() },
  { method: "GET", path: "/connexion", access: "public", handler: handleLoginPage },
  { method: "POST", path: "/connexion/code", access: "public", handler: (req) => handleRequestCode(req) },
  { method: "POST", path: "/connexion/verifier", access: "public", handler: (req) => handleVerifyCode(req) },
  { method: "POST", path: "/deconnexion", access: "user", handler: (req) => handleLogout(req) },
  { method: "GET", path: "/", access: "user", handler: (req, url, user) => dashboard(req, url, user!) },
  { method: "GET", path: "/profil", access: "user", handler: async (_req, _url, user) => profilePage(user!) },
  { method: "POST", path: "/profil", access: "user", handler: (req, url, user) => handleProfileUpdate(req, url, user!) },
  { method: "POST", path: "/profil/deconnexion-partout", access: "user", handler: (req, url, user) => handleLogoutEverywhere(req, url, user!) },
  { method: "GET", path: "/avis/:idweb", access: "user", handler: (_req, _url, user, params) => avisPage(user!, params.idweb ?? "") },
  { method: "POST", path: "/avis/:idweb/commenter", access: "user", handler: (req, url, user, params) => handleAddComment(req, url, user!, params) },
  { method: "GET", path: "/avis/:idweb/commentaires/flux", access: "user", handler: async (req, _url, user, params) => {
      if (!rateLimit(`flux:${user!.id}`, 30, 60_000)) return new Response("Trop de connexions", { status: 429 });
      return commentStream(req, params.idweb ?? "");
    } },
  { method: "POST", path: "/commentaires/supprimer", access: "user", handler: (req, url, user) => handleDeleteComment(req, url, user!) },
  { method: "POST", path: "/avis/:idweb/statut", access: "user", handler: (req, url, user, params) => handleSetStatus(req, url, user!, params) },
  { method: "GET", path: "/configuration", access: "config", handler: (req, url, user) => handleConfigHome(req, url, user!) },
  { method: "POST", path: "/configuration/mots-cles/ajouter", access: "config", handler: (req, url, user) => handleKeywordAdd(req, url, user!) },
  { method: "POST", path: "/configuration/mots-cles/supprimer", access: "config", handler: (req, url, user) => handleKeywordDelete(req, url, user!) },
  { method: "POST", path: "/configuration/regles/ajouter", access: "config", handler: (req, url, user) => handleRuleAdd(req, url, user!) },
  { method: "POST", path: "/configuration/regles/supprimer", access: "config", handler: (req, url, user) => handleRuleDelete(req, url, user!) },
  { method: "POST", path: "/configuration/reglages", access: "config", handler: (req, url, user) => handleSettingsUpdate(req, url, user!) },
  { method: "POST", path: "/configuration/relancer", access: "config", handler: (req, url, user) => handleRelance(req, url, user!) },
  { method: "GET", path: "/admin", access: "admin", handler: (_req, _url, user) => adminPage(user!) },
  { method: "POST", path: "/admin/configurer", access: "admin", handler: (req, url, user) => handleAdminConfigure(req, url, user!) },
  { method: "POST", path: "/admin/ajouter", access: "admin", handler: (req, url, user) => handleAdminAdd(req, url, user!) },
  { method: "POST", path: "/admin/supprimer", access: "admin", handler: (req, url, user) => handleAdminDelete(req, url, user!) },
  { method: "POST", path: "/admin/statuts/ajouter", access: "admin", handler: (req, url, user) => handleAdminStatusAdd(req, url, user!) },
  { method: "POST", path: "/admin/statuts/renommer", access: "admin", handler: (req, _url, user) => handleAdminStatusAction(req, user!, "renommer") },
  { method: "POST", path: "/admin/statuts/monter", access: "admin", handler: (req, _url, user) => handleAdminStatusAction(req, user!, "monter") },
  { method: "POST", path: "/admin/statuts/descendre", access: "admin", handler: (req, _url, user) => handleAdminStatusAction(req, user!, "descendre") },
  { method: "POST", path: "/admin/statuts/archiver", access: "admin", handler: (req, _url, user) => handleAdminStatusAction(req, user!, "archiver") },
  { method: "POST", path: "/admin/statuts/rejet", access: "admin", handler: (req, _url, user) => handleAdminStatusAction(req, user!, "rejet") },
];

function crossOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && crossOrigin(req, url)) {
    return new Response("Origine non autorisée", { status: 403 });
  }

  let params: Record<string, string> = {};
  const route = routes.find((r) => {
    if (r.method !== req.method) return false;
    const m = matchPath(r.path, url.pathname);
    if (!m) return false;
    params = m;
    return true;
  });
  if (!route) return html(errorPage("Page introuvable"), 404);

  let session = null;
  if (route.path !== "/sante" && route.path !== "/health") {
    try {
      session = await getSession(req);
    } catch (err) {
      console.error(`session lookup failed: ${err}`);
      if (route.access !== "public") {
        return html(errorPage(err instanceof Error ? err.message : String(err)), 500);
      }
    }
  }
  const user = session?.user ?? null;

  if (route.access !== "public") {
    if (!user) {
      return req.method === "GET"
        ? redirect("/connexion", 302)
        : new Response("Authentification requise", { status: 403 });
    }
    if (route.access === "admin" && !user.isAdmin) {
      return new Response("Accès réservé à l'administrateur.", { status: 403 });
    }
    if (route.access === "config" && !user.isAdmin && !user.canConfigure) {
      return new Response("Accès réservé aux utilisateurs autorisés à configurer la veille.", {
        status: 403,
      });
    }
  }

  const res = await route.handler(req, url, user, params);
  if (session?.refreshCookie && !res.headers.has("Set-Cookie")) {
    res.headers.append("Set-Cookie", session.refreshCookie);
  }
  return res;
}

await migrate()
  .then(() => seedAdmins())
  .catch((err) => {
    // Boot anyway: pages show an error and /sante reports degraded.
    console.error(`startup migration/seed failed: ${err}`);
  });

// Non fatal : sans moteur Skip le flux répond 503 et la page affiche
// « Commentaires indisponibles », le reste du tableau de bord fonctionne.
await startLive().catch((err) => {
  console.error(`live: démarrage Skip impossible — commentaires non réactifs : ${err}`);
});

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8080),
  hostname: "0.0.0.0",
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`request error: ${msg}`);
      return html(errorPage(msg), 500);
    }
  },
});

console.error(`dashboard listening on http://${server.hostname}:${server.port}`);
