// Sources secondaires sur plateforme atexo MPE (framework PRADO) : Maximilien
// (Île-de-France), Marchés publics d'Aquitaine (demat-ampa.fr)… — même logiciel,
// même HTML, seule l'URL change (`MPE_SITES`). Tout est public : la liste des
// consultations ouvertes (« ?page=Entreprise.EntrepriseAdvancedSearch&AllCons »,
// 20 par page), les fiches (/entreprise/consultation/<id>?orgAcronyme=<org>).
// La pagination est un « postback » : un PRADO_PAGESTATE reçu est renvoyé avec
// une cible et le cookie de session — sans cookie le serveur répond 400. La
// liste arrive par 10 : un premier postback (cible « listePageSizeTop ») la
// repasse à 20 par page, puis CHAQUE page est demandée depuis ce même état
// (cible « DefaultButtonTop » = « aller à la page N »). On n'enchaîne plus les
// « page suivante » : chaque état (~60 Ko, opaque) est une occasion pour le
// pare-feu du site de bloquer la requête à tort (voir `estBlocage`), et le
// premier « suivant » sautait les rangs 11 à 20. Comme pour achatpublic, on lit
// toute la liste puis on filtre localement (nature « Services », mots-clés par
// famille sur intitulé + objet) ; la fiche n'est lue que pour les consultations
// retenues (CPV, type d'annonce).
import { matchKeywords, type FamilleSearch } from "./familles.ts";
import { moisCode } from "./mois.ts";
import type { Announcement, Source } from "./scraper.ts";
import { errMessage } from "./http.ts";
import { reusable, toAnnouncement as knownAnnouncement, type KnownLookup } from "./known.ts";

export type MpeSite = {
  source: Source;
  name: string; // libellé des journaux / avertissements
  base: string; // https://… sans barre finale
  prefix: string; // préfixe des idweb (« MX- »)
  env: string; // variable d'environnement « =0 » qui désactive le site
};

export const MPE_SITES: readonly MpeSite[] = [
  { source: "maximilien", name: "Maximilien", base: "https://marches.maximilien.fr", prefix: "MX-", env: "MAXIMILIEN" },
  { source: "ampa", name: "AMPA (demat-ampa.fr)", base: "https://demat-ampa.fr", prefix: "AMPA-", env: "AMPA" },
];

const LIST_PATH = "/?page=Entreprise.EntrepriseAdvancedSearch&AllCons";
const USER_AGENT = "avis-en-cours (veille marchés publics)";
const PAGE_SIZE = "20";
const SIZE_TARGET = "ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop";
const GOTO_TARGET = "ctl0$CONTENU_PAGE$resultSearch$DefaultButtonTop";
// Sessions essayées quand le pare-feu bloque : les deux serveurs du site
// produisent des états différents, une nouvelle session peut tomber sur l'autre.
const MAX_SESSIONS = 3;
const MAX_DEPARTEMENTS = 15;

export type MxRow = {
  id: string;
  org: string;
  procedure: string;
  categorie: string;
  publie: string; // dd/mm/yyyy
  reference: string;
  intitule: string;
  objet: string;
  organisme: string;
  lieux: string;
  lots: string;
  deadline: string | null; // dd/mm/yyyy à HHhMM
};

export type MxFiche = { typeAnnonce: string; cpv: string; objet: string };

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function line(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Bloc « <div class="date …"> jour / mois / année » (+ heure « 17:00 » à côté).
function dateBlock(html: string, time?: string): string | null {
  const day = html.match(/class="day\s*"?[^>]*>\s*<span>\s*(\d{1,2})\s*<\/span>/);
  const month = html.match(/class="month"[^>]*>\s*<span>\s*([^<]+?)\s*<\/span>/);
  const year = html.match(/class="year"[^>]*>\s*<span>\s*(\d{4})\s*<\/span>/);
  const mm = month ? moisCode(month[1]!) : null;
  if (!day || !mm || !year) return null;
  const date = `${day[1]!.padStart(2, "0")}/${mm}/${year[1]}`;
  const t = time?.match(/^(\d{1,2}):(\d{2})$/);
  return t ? `${date} à ${t[1]!.padStart(2, "0")}h${t[2]}` : date;
}

function section(html: string, marker: string): string {
  const i = html.indexOf(marker);
  if (i < 0) return "";
  const j = html.indexOf("<!-- END", i);
  return html.slice(i, j < 0 ? undefined : j);
}

export function parseRows(html: string): MxRow[] {
  const rows: MxRow[] = [];
  const blocks = html.split(/class="item_consultation list-group-item/).slice(1);
  for (const b of blocks) {
    const id = b.match(/\$refCons"[^>]*value="(\d+)"/)?.[1];
    if (!id) continue;
    const pub = b.match(/<div class="date date-min[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] ?? "";
    const closure = b.match(/class="cloture-line">[\s\S]*?<\/label>/)?.[0] ?? "";
    const time = closure.match(/<label title="Durée"[^>]*>\s*([^<]*?)\s*<\/label>/)?.[1];
    const intituleBlock = section(b, "BEGIN REFERENCE | INTITULE");
    const lieuxBlock = b.match(/class="lieux-exe">[\s\S]*?<\/div>/)?.[0] ?? "";
    const lieuxFull = lieuxBlock.match(/data-content="([^"]*)"/)?.[1];
    const lieuxShort = lieuxBlock.match(/<span>\s*<i[^>]*><\/i>\s*<span>([^<]*)<\/span>/)?.[1];
    rows.push({
      id,
      org: b.match(/\$orgCons"[^>]*value="([^"]*)"/)?.[1] ?? "",
      procedure: line(b.match(/class="cons_procedure">[\s\S]*?title="([^"]*)"/)?.[1] ?? ""),
      categorie: line(b.match(/class="cons_categorie">\s*<span>([^<]*)<\/span>/)?.[1] ?? ""),
      publie: dateBlock(pub) ?? "",
      reference: line(intituleBlock.match(/<div class="small pull-left">\s*([\s\S]*?)\s*<\/div>/)?.[1] ?? ""),
      intitule: line(intituleBlock.match(/<span data-toggle="tooltip"\s+title="([^"]*)"/)?.[1] ?? ""),
      objet: line(section(b, "BEGIN OBJET").match(/class="truncate-700"\s+title="([^"]*)"/)?.[1] ?? ""),
      organisme: line(section(b, "BEGIN ORGANISME").match(/class="truncate-700"\s+title="([^"]*)"/)?.[1] ?? ""),
      lieux: line(lieuxFull ?? lieuxShort ?? ""),
      lots: b.match(/<span>(\d+)&nbsp;lots?<\/span>/)?.[1] ?? "",
      deadline: dateBlock(closure, time),
    });
  }
  return rows;
}

export function parsePageState(html: string): string | null {
  return html.match(/id="PRADO_PAGESTATE" value="([^"]*)"/)?.[1] ?? null;
}

// « numPageTop … value="2" » et « nombrePageTop">44 » ; « nombreElement">439 ».
export function parsePagination(html: string): { page: number; pages: number; total: number | null } {
  const page = Number(html.match(/numPageTop" type="text" value="(\d+)"/)?.[1] ?? "1");
  const pages = Number(html.match(/nombrePageTop">\s*(\d+)/)?.[1] ?? "1");
  const total = html.match(/nombreElement">\s*(\d+)/)?.[1];
  return { page, pages, total: total ? Number(total) : null };
}

export function parseFiche(html: string): MxFiche {
  const t = line(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " "));
  const grab = (label: string, stop: string) => t.match(new RegExp(`${label}\\s*:\\s*(.*?)\\s*(?=${stop})`))?.[1] ?? "";
  return {
    typeAnnonce: grab("Type d'annonce", "Procédure\\s*:"),
    cpv: grab("Code CPV", "Temps restant|Bourse|Publicité|$").replace(/\s*\(Code principal\)\s*/g, " (principal) ").trim(),
    objet: grab("Objet", "Organisme\\s*:"),
  };
}

export type MaximilienClient = { fetch: (url: string, init: RequestInit) => Promise<Response> };
const defaultClient: MaximilienClient = { fetch: (u, i) => fetch(u, i) };

// Le pare-feu applicatif du site (« système de détection d'intrusion ») refuse
// certaines requêtes d'après leur contenu : 303 vers /forbidden/index.html,
// page « Accès refusé » servie en 200. Vu le 2026-11-22 sur Maximilien : l'état
// de la page 20 était refusé à chaque envoi, et la page de refus, sans
// pagination, était prise pour un retour à la page 1 (« pagination incohérente »).
export function estBlocage(finalUrl: string, body: string): boolean {
  return /\/forbidden\//.test(finalUrl) || /syst[eè]me de d[eé]tection d'intrusion a bloqu[eé]/i.test(body);
}

// Rejouer la même requête ne sert à rien (le refus tient à son contenu) :
// l'erreur n'est pas réessayée par Session, c'est scrapeMpe qui change d'état
// ou de session.
export class MpeBlockedError extends Error {
  constructor(readonly reference: string | null) {
    super(`requête bloquée par le pare-feu du site${reference ? ` (réf. ${reference})` : ""}`);
    this.name = "MpeBlockedError";
  }
}

class Session {
  // Un cookie par nom : le site renvoie SERVERID à chaque réponse.
  private readonly cookies = new Map<string, string>();
  constructor(private readonly client: MaximilienClient) {}

  async request(url: string, init: RequestInit = {}): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.client.fetch(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            "user-agent": USER_AGENT,
            cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(45_000),
        });
        for (const sc of res.headers.getSetCookie()) {
          const m = sc.match(/^([^=]+)=([^;]+)/);
          if (m) this.cookies.set(m[1]!, m[2]!);
        }
        const body = await res.text();
        if (estBlocage(res.url, body)) {
          throw new MpeBlockedError(res.url.match(/[?&]uid=([^&]+)/)?.[1] ?? null);
        }
        if (!res.ok) throw new Error(`MPE ${res.status} ${res.statusText} sur ${url.slice(0, 80)}`);
        return body;
      } catch (err) {
        if (err instanceof MpeBlockedError) throw err;
        lastErr = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error(`site injoignable : ${errMessage(lastErr)}`);
  }
}

export type ScrapeMpeOptions = {
  site: MpeSite;
  searches: readonly FamilleSearch[];
  maxPages?: number;
  client?: MaximilienClient;
  log?: (msg: string) => void;
  // Avancement : pages de liste lues / pages annoncées.
  onPage?: (done: number, total: number | null) => void;
  // Avis déjà connus : fiche non relue si la ligne est inchangée (src/known.ts).
  known?: KnownLookup;
};

export type MpeItem = Announcement & { matchedQueries: string[] };

const CATEGORIE: Record<FamilleSearch["marche"], string> = { services: "Services", fournitures: "Fournitures" };

type Retenue = { row: MxRow; famille: FamilleSearch["famille"]; keywords: string[] };
type Liste = { matched: Map<string, Retenue>; count: number; pages: number; total: number | null };

function postback(state: string, target: string, page: number): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      PRADO_PAGESTATE: state,
      PRADO_POSTBACK_TARGET: target,
      PRADO_POSTBACK_PARAMETER: "",
      "ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop": PAGE_SIZE,
      "ctl0$CONTENU_PAGE$resultSearch$numPageTop": String(page),
    }).toString(),
  };
}

// Une lecture complète de la liste dans une session. Lève MpeBlockedError si
// le pare-feu refuse une page avec les deux états disponibles.
async function lireListe(opts: ScrapeMpeOptions, session: Session, maxPages: number): Promise<Liste> {
  const listUrl = `${opts.site.base}${LIST_PATH}`;
  const accueil = await session.request(listUrl);
  const etatAccueil = parsePageState(accueil);
  if (!etatAccueil) {
    // Liste vide ou tenant sur une page sans pagination : rien à paginer.
    if (parseRows(accueil).length === 0 && parsePagination(accueil).total !== 0) {
      throw new Error("aucune consultation lue — structure de page changée ?");
    }
    throw new Error("PRADO_PAGESTATE introuvable (pagination impossible)");
  }
  // Page 1 à 20 lignes : son état sert ensuite à demander toutes les autres.
  let html = await session.request(listUrl, postback(etatAccueil, SIZE_TARGET, 1));
  const etat = parsePageState(html);
  if (!etat) throw new Error("PRADO_PAGESTATE introuvable (pagination impossible)");
  let { page, pages, total } = parsePagination(html);
  if (page !== 1) throw new Error(`pagination incohérente (page ${page} au lieu de 1/${pages})`);

  const seen = new Set<string>();
  const matched = new Map<string, Retenue>();
  for (;;) {
    opts.onPage?.(page, pages);
    const rows = parseRows(html);
    if (rows.length === 0 && page === 1 && total !== 0) throw new Error("aucune consultation lue — structure de page changée ?");
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      for (const s of opts.searches) {
        if (row.categorie !== CATEGORIE[s.marche]) continue;
        const kws = matchKeywords(`${row.intitule} ${row.objet}`, s.keywords);
        if (kws.length > 0 && !matched.has(row.id)) matched.set(row.id, { row, famille: s.famille, keywords: kws });
      }
    }
    if (page >= pages || page >= maxPages) break;
    const cible = page + 1;
    // État de la page qu'on vient de lire : second choix si le pare-feu
    // refuse l'état de la page 1 (les deux n'ont pas le même contenu).
    const secours = parsePageState(html);
    try {
      html = await session.request(listUrl, postback(etat, GOTO_TARGET, cible));
    } catch (err) {
      if (!(err instanceof MpeBlockedError) || !secours || secours === etat) throw err;
      html = await session.request(listUrl, postback(secours, GOTO_TARGET, cible));
    }
    const next = parsePagination(html);
    if (next.page !== cible) throw new Error(`pagination incohérente (page ${next.page} au lieu de ${cible}/${pages})`);
    page = next.page;
    pages = next.pages;
  }
  // Garde-fou : une liste lue en entier doit contenir (à quelques clôtures
  // près pendant la lecture) autant de consultations qu'annoncé. Le saut des
  // rangs 11–20 (393 lues sur 403) est resté invisible faute de ce contrôle.
  if (total !== null && page >= pages && total - seen.size > Math.max(5, total * 0.02)) {
    throw new Error(`liste incomplète (${seen.size} consultations lues sur ${total} annoncées)`);
  }
  return { matched, count: seen.size, pages: page, total };
}

export async function scrapeMpe(opts: ScrapeMpeOptions): Promise<MpeItem[]> {
  const { site } = opts;
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? 150;
  const client = opts.client ?? defaultClient;

  let session = new Session(client);
  let liste: Liste | null = null;
  for (let essai = 1; liste === null; essai++) {
    try {
      liste = await lireListe(opts, session, maxPages);
    } catch (err) {
      if (!(err instanceof MpeBlockedError) || essai >= MAX_SESSIONS) throw err;
      log(`  ${site.name}: ${err.message} — nouvelle session (${essai + 1}/${MAX_SESSIONS})`);
      session = new Session(client);
    }
  }
  const { matched, count, pages: page, total } = liste;
  log(`  ${site.name}: ${count} consultations sur ${page} page(s)${total !== null ? ` (annoncées : ${total})` : ""}, ${matched.size} retenue(s)`);

  const out: MpeItem[] = [];
  let reprises = 0;
  for (const { row, famille, keywords } of matched.values()) {
    const known = opts.known?.(`${site.prefix}${row.id}`);
    if (known && reusable(known, { url: ficheUrl(site, row), objet: row.intitule || row.objet, deadline: row.deadline })) {
      out.push({ ...knownAnnouncement(known), source: site.source, famille, matchedQueries: keywords });
      reprises++;
      continue;
    }
    let fiche: MxFiche = { typeAnnonce: "", cpv: "", objet: "" };
    try {
      fiche = parseFiche(await session.request(ficheUrl(site, row)));
    } catch (err) {
      log(`  fiche ${site.name} ${row.id} illisible : ${errMessage(err)}`);
    }
    out.push({ ...toAnnouncement(row, fiche, famille, site), matchedQueries: keywords });
  }
  log(`  ${site.name}: ${matched.size - reprises} fiche(s) lue(s), ${reprises} reprise(s) inchangée(s)`);
  return out;
}

function ficheUrl(site: MpeSite, row: MxRow): string {
  return `${site.base}/entreprise/consultation/${row.id}?orgAcronyme=${encodeURIComponent(row.org)}`;
}

// « (75) Paris, (77) Seine-et-Marne » -> « 75, 77 » ; toute la France -> « France entière ».
export function departementsFromLieux(lieux: string): string {
  const codes = [...new Set([...lieux.matchAll(/\((\d{2,3}|2A|2B)\)/g)].map((m) => m[1]!))];
  return codes.length > MAX_DEPARTEMENTS ? "France entière" : codes.join(", ");
}

export function toAnnouncement(row: MxRow, fiche: MxFiche, famille: FamilleSearch["famille"], site: MpeSite): Announcement {
  const objet = row.intitule || row.objet;
  const description = fiche.objet || row.objet;
  const raw = [
    objet,
    description && description !== objet ? description : "",
    fiche.cpv ? `CPV: ${fiche.cpv}` : "",
    row.organisme ? `Acheteur: ${row.organisme}` : "",
    row.lieux ? `Lieu: ${row.lieux.slice(0, 300)}` : "",
    row.categorie ? `Nature: ${row.categorie}` : "",
    row.procedure ? `Procédure: ${row.procedure}` : "",
    fiche.typeAnnonce ? `Type d'annonce: ${fiche.typeAnnonce}` : "",
    row.lots ? `Lots: ${row.lots}` : "",
    row.reference ? `Référence: ${row.reference}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    idweb: `${site.prefix}${row.id}`,
    url: ficheUrl(site, row),
    publishedAt: row.publie,
    deadline: row.deadline,
    objet,
    department: departementsFromLieux(row.lieux),
    acheteur: row.organisme,
    typeAvis: `Consultation ${site.name}${fiche.typeAnnonce ? ` — ${fiche.typeAnnonce}` : ""} (${row.categorie || "?"})`,
    procedure: row.procedure,
    raw,
    source: site.source,
    famille,
  };
}
