import {
  migrate,
  getLastRun,
  getLastSuccessfulRun,
  getCurrent,
  getAnnouncement,
  getComments,
  addComment,
  deleteComment,
  type CommentRow,
  type StoredAnnouncement,
  type RunRow,
} from "./db.ts";
import { matchPath } from "./router.ts";
import {
  type AuthUser,
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
  updateProfile,
  deleteAllSessions,
} from "./auth.ts";
import { sendLoginCode } from "./email.ts";

// --- Shared rendering -------------------------------------------------------

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

async function adminPage(user: AuthUser, error?: string): Promise<Response> {
  const users = await listUsers();
  const rows = users
    .map(
      (u) => `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.name ?? "—")}</td>
        <td>${u.is_admin ? "oui" : "non"}</td>
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
        <thead><tr><th>Email</th><th>Nom</th><th>Admin</th><th>Dernière connexion</th><th></th></tr></thead>
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

// --- Avis detail + comments ------------------------------------------------------

function commentBlock(c: CommentRow & { idweb: string }, viewer: AuthUser): string {
  const author = c.user_id === null ? "utilisateur supprimé" : (c.author_name ?? c.author_email ?? "?");
  const canDelete = viewer.isAdmin || (c.user_id !== null && Number(c.user_id) === viewer.id);
  return `
  <div class="comment">
    <div class="comment-head">
      <strong>${esc(author)}</strong>
      <span>${esc(frDateTime(new Date(c.created_at)))}</span>
      ${
        canDelete
          ? `<form method="post" action="/commentaires/supprimer" style="margin:0;">
               <input type="hidden" name="id" value="${c.id}">
               <input type="hidden" name="idweb" value="${esc(c.idweb)}">
               <button class="subtle" type="submit">Supprimer</button>
             </form>`
          : ""
      }
    </div>
    <div class="comment-body">${esc(c.body)}</div>
  </div>`;
}

async function avisPage(user: AuthUser, idweb: string, error?: string): Promise<Response> {
  const a = await getAnnouncement(idweb);
  if (!a) return html(errorPage("Avis introuvable"), 404);
  const comments = await getComments(idweb);

  const facts: Array<[string, string | null]> = [
    ["Acheteur", a.acheteur],
    ["Département", a.department],
    ["Date limite", a.deadline_text],
    ["Publié le", a.published_at],
    ["Type d'avis", a.type_avis],
    ["Procédure", a.procedure],
    ["Classement", a.reason],
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
      <div class="card" style="max-width:none;margin:16px 0;">
        <h2>Commentaires (${comments.length})</h2>
        ${
          comments.length === 0
            ? `<p style="color:#78716c;">Aucun commentaire pour l'instant. Lancez la discussion.</p>`
            : comments.map((c) => commentBlock({ ...c, idweb }, user)).join("")
        }
        ${error ? `<div class="banner error">${esc(error)}</div>` : ""}
        <form method="post" action="/avis/${encodeURIComponent(idweb)}/commenter" style="margin-top:16px;">
          <label for="body">Ajouter un commentaire</label>
          <textarea id="body" name="body" required maxlength="4000"
                    placeholder="Votre analyse, une question, une décision…"></textarea>
          <div class="actions"><button class="primary" type="submit">Publier</button></div>
        </form>
      </div>
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
  if (!a) return html(errorPage("Avis introuvable"), 404);

  if (!rateLimit(`comment:${user.id}`, 20, 600_000)) {
    return avisPage(user, idweb, MSG_RATE_LIMITED);
  }
  const { body = "" } = await form(req);
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 4000) {
    return avisPage(user, idweb, "Le commentaire est vide ou trop long (4000 caractères max).");
  }
  await addComment(idweb, user.id, trimmed);
  return redirect(`/avis/${encodeURIComponent(idweb)}`, 303);
}

async function handleDeleteComment(req: Request, _url: URL, user: AuthUser): Promise<Response> {
  const { id = "", idweb = "" } = await form(req);
  const commentId = Number(id);
  if (Number.isInteger(commentId)) await deleteComment(commentId, user.id, user.isAdmin);
  return redirect(idweb ? `/avis/${encodeURIComponent(idweb)}` : "/", 303);
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
      } — <a class="comments-link" href="/avis/${encodeURIComponent(a.idweb)}">${
        (a.comment_count ?? 0) > 0 ? `Commentaires (${a.comment_count})` : "Commenter"
      }</a></div>
      ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}
    </td>
    <td class="pub">${esc(a.published_at ?? "?")}</td>
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
    .pub { white-space: nowrap; color: var(--encre-2); font-family: var(--fonte-mono); font-size: 12px; }
    .badge { display: inline-block; background: #e5efe9; color: var(--vert); font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 4px; margin-left: 7px; vertical-align: 1px; }
    .empty { color: var(--encre-2); padding: 32px; text-align: center; background: var(--carte); border: 1px solid var(--ligne); border-radius: 8px; font-size: 13.5px; }
    @media (max-width: 640px) { thead th:last-child, td.pub { display: none; } .deadline { width: 88px; } .jdate { white-space: normal; } }
`;

async function dashboard(req: Request, url: URL, user: AuthUser): Promise<Response> {
  const cat = url.searchParams.get("cat") === "travaux" ? "travaux" : "pertinents";
  const dbCategory = cat === "travaux" ? "travaux" : "relevant";

  const [lastRun, lastSuccess] = await Promise.all([getLastRun(), getLastSuccessfulRun()]);
  const items = lastSuccess ? await getCurrent(dbCategory, lastSuccess.id) : [];
  const latestRunId = lastSuccess?.id ?? null;

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
          <thead><tr><th>Échéance</th><th>Objet</th><th>Publié le</th></tr></thead>
          <tbody>${items.map((a) => announcementRow(a, latestRunId)).join("")}</tbody>
        </table>`;

  const body = `
  <style>${DASHBOARD_CSS}</style>
  <main>
    ${banner(lastRun, lastSuccess)}
    ${tabs}
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

// --- Health -----------------------------------------------------------------------

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

// --- Router -----------------------------------------------------------------------

type Access = "public" | "user" | "admin";
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
  { method: "POST", path: "/commentaires/supprimer", access: "user", handler: (req, url, user) => handleDeleteComment(req, url, user!) },
  { method: "GET", path: "/admin", access: "admin", handler: (_req, _url, user) => adminPage(user!) },
  { method: "POST", path: "/admin/ajouter", access: "admin", handler: (req, url, user) => handleAdminAdd(req, url, user!) },
  { method: "POST", path: "/admin/supprimer", access: "admin", handler: (req, url, user) => handleAdminDelete(req, url, user!) },
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
