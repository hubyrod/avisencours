// Source secondaire : les avis financés par l'AFD sur dgMarket
// (afd.dgmarket.com), catégorie « Transports » (paramètre sub=15), avis en
// cours (status=live). Tout est public : la liste, le filtre et le texte
// complet des avis (seul le téléchargement des dossiers demande un abonnement).
// Particularité : la première requête est redirigée trois fois vers
// web3-login.dgmarket.com (« autoLogin » anonyme) qui pose le cookie
// digi_session_id sur les deux domaines — d'où un petit pot à cookies par
// domaine et un suivi manuel des redirections. 20 avis par page, les pages
// suivantes s'atteignent par le lien « Suivant ». Les avis sont pour l'étranger
// (pays dans `department`), souvent en anglais ; ils passent par les
// classifieurs mobilité comme les avis BOAMP.
import type { Announcement } from "./scraper.ts";
import { errMessage } from "./http.ts";
import { moisCode } from "./mois.ts";

export const AFD_BASE = "https://afd.dgmarket.com";
const LIST_URL = `${AFD_BASE}/tenders/brandedNoticeList.do`;
const TRANSPORTS_CATEGORY = "15";
const USER_AGENT = "avis-en-cours (veille marchés publics)";

export type AfdRow = { id: string; pays: string; objet: string; publie: string; deadline: string };

export type AfdNotice = {
  objet: string;
  typeAvis: string;
  pays: string;
  ville: string;
  publie: string;
  deadline: string;
  acheteur: string;
  langue: string;
  texte: string;
};

// « Sept 17, 2026 », « Aou 31, 2026 », « Octobre 2, 2026 - 12:00 »
//   -> « 17/09/2026 » ou « 02/10/2026 à 12h00 » (format du reste du projet).
export function parseAfdDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-zéûÉ]+)\.?\s+(\d{1,2}),\s*(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const mm = moisCode(m[1]!);
  if (!mm) return null;
  const date = `${m[2]!.padStart(2, "0")}/${mm}/${m[3]}`;
  return m[4] ? `${date} à ${m[4].padStart(2, "0")}h${m[5]}` : date;
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function text(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function line(html: string): string {
  return text(html).replace(/\s+/g, " ");
}

export function parseListRows(html: string): AfdRow[] {
  const rows: AfdRow[] = [];
  const table = html.match(/<table[^>]*id="notice"[\s\S]*?<\/table>/)?.[0] ?? "";
  for (const m of table.matchAll(/<tr class="(?:odd|even)">([\s\S]*?)<\/tr>/g)) {
    const tr = m[1]!;
    const pays = tr.match(/class="country">([\s\S]*?)<\/td>/);
    const link = tr.match(/<a href="\/tender\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
    const publie = tr.match(/class="published"[^>]*>([\s\S]*?)<\/td>/);
    const deadline = tr.match(/class="deadline"[^>]*>([\s\S]*?)<\/td>/);
    if (!link) continue;
    rows.push({
      id: link[1]!,
      objet: line(link[2]!),
      pays: pays ? line(pays[1]!) : "",
      publie: publie ? line(publie[1]!) : "",
      deadline: deadline ? line(deadline[1]!) : "",
    });
  }
  return rows;
}

// Lien « Suivant » du pager (absent sur la dernière page).
export function parseNextLink(html: string): string | null {
  const m = html.match(/<a href="([^"]+)">\s*Suivant\s*<\/a>/);
  return m ? decode(m[1]!) : null;
}

// « 1-20 de 118 » -> 118 ; absent -> null.
export function parseTotal(html: string): number | null {
  const m = html.match(/\d+-\d+ de (\d+)/);
  return m ? Number(m[1]) : null;
}

function fact(html: string, label: string): string {
  const re = new RegExp(`${label}\\s*:?(?:&nbsp;)*\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`);
  const m = html.match(re);
  return m ? line(m[1]!) : "";
}

export function parseNotice(html: string): AfdNotice {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
  const title = body.match(/<div class="notice-title">\s*<h1>([\s\S]*?)<\/h1>(?:\s*<h4>([\s\S]*?)<\/h4>)?/);
  const texte = body.match(/<div class="fixwhitespace-wrapper">([\s\S]*?)<\/div>/);
  return {
    objet: title ? line(title[1]!) : "",
    typeAvis: title?.[2] ? line(title[2]) : "",
    pays: fact(body, "Pays"),
    ville: fact(body, "Ville\\/Localité"),
    publie: fact(body, "Date de publication"),
    deadline: fact(body, "Date limite \\(heure locale\\)"),
    acheteur: fact(body, "Acheteur"),
    langue: fact(body, "Langue d'origine"),
    texte: texte ? text(texte[1]!) : "",
  };
}

export type AfdClient = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultClient: AfdClient = { fetch: (u, i) => fetch(u, i) };

// Pot à cookies minimal : par domaine (attribut Domain, sinon l'hôte), envoyé
// aux hôtes qui se terminent par ce domaine. Suffisant pour le trio
// afd.dgmarket.com / web3-login.dgmarket.com / .dgmarket.com.
export class CookieJar {
  private readonly jar = new Map<string, Map<string, string>>();

  store(host: string, setCookies: string[]): void {
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      if (eq < 1) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const domain = (domainAttr ? domainAttr.slice(7) : host).replace(/^\./, "").toLowerCase();
      if (!this.jar.has(domain)) this.jar.set(domain, new Map());
      this.jar.get(domain)!.set(name, value);
    }
  }

  header(host: string): string {
    const h = host.toLowerCase();
    const out: string[] = [];
    for (const [domain, cookies] of this.jar) {
      if (h === domain || h.endsWith(`.${domain}`)) for (const [n, v] of cookies) out.push(`${n}=${v}`);
    }
    return out.join("; ");
  }
}

class Session {
  readonly jar = new CookieJar();
  constructor(private readonly client: AfdClient) {}

  // Suit les redirections à la main pour conserver les cookies posés en route.
  async request(url: string, init: RequestInit = {}): Promise<string> {
    let current = url;
    let cur: RequestInit = init;
    for (let hop = 0; hop < 8; hop++) {
      const host = new URL(current).host;
      const res = await this.client.fetch(current, {
        ...cur,
        headers: { ...(cur.headers as Record<string, string>), "user-agent": USER_AGENT, cookie: this.jar.header(host) },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      this.jar.store(host, res.headers.getSetCookie());
      const body = await res.text();
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`AFD : redirection sans Location depuis ${current}`);
        current = new URL(loc, current).toString();
        cur = { method: "GET" };
        continue;
      }
      if (!res.ok) throw new Error(`AFD ${res.status} ${res.statusText} sur ${current}`);
      if (/requires digi_session_id/.test(body)) throw new Error("AFD : session refusée (cookie digi_session_id)");
      return body;
    }
    throw new Error(`AFD : trop de redirections depuis ${url}`);
  }
}

export type ScrapeAfdOptions = {
  maxPages?: number;
  client?: AfdClient;
  log?: (msg: string) => void;
  // Avancement : pages de liste lues (le total n'est pas annoncé).
  onPage?: (done: number, total: number | null) => void;
};

export async function scrapeAfd(opts: ScrapeAfdOptions = {}): Promise<Announcement[]> {
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? 20;
  const session = new Session(opts.client ?? defaultClient);

  // Première visite : ouvre la session anonyme (redirections autoLogin).
  await session.request(LIST_URL);
  let html = await session.request(LIST_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      data_type: "P", updated: "all", keywords: "", referenceNo: "", locationISO: "", updatedId: "",
      status: "live", noticeType: "", sub: TRANSPORTS_CATEGORY, task: "Rechercher",
    }).toString(),
  });
  const total = parseTotal(html);
  const rows: AfdRow[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    opts.onPage?.(page, null);
    const pageRows = parseListRows(html);
    if (pageRows.length === 0 && page === 1 && total !== 0 && !/Aucun avis trouvé/.test(html)) {
      throw new Error("AFD : aucune ligne lue — structure de page changée ?");
    }
    for (const r of pageRows) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    const next = parseNextLink(html);
    if (!next || page >= maxPages) break;
    html = await session.request(new URL(next, LIST_URL).toString());
  }
  log(`  AFD transports: ${rows.length} avis en cours${total !== null ? ` (annoncés : ${total})` : ""}`);

  const out: Announcement[] = [];
  for (const row of rows) {
    let notice: AfdNotice | null = null;
    try {
      notice = parseNotice(await session.request(`${AFD_BASE}/tender/${row.id}`));
    } catch (err) {
      log(`  avis AFD ${row.id} illisible : ${errMessage(err)}`);
    }
    out.push(toAnnouncement(row, notice));
  }
  return out;
}

export function toAnnouncement(row: AfdRow, notice: AfdNotice | null): Announcement {
  const objet = notice?.objet || row.objet;
  const deadline = parseAfdDate(notice?.deadline || row.deadline);
  const publishedAt = parseAfdDate(notice?.publie || row.publie) ?? (notice?.publie || row.publie);
  const pays = notice?.pays || row.pays;
  const raw = [
    objet,
    notice?.texte ? notice.texte.slice(0, 3000) : "",
    notice?.acheteur ? `Acheteur: ${notice.acheteur}` : "",
    pays ? `Pays: ${pays}${notice?.ville ? ` (${notice.ville})` : ""}` : "",
    notice?.typeAvis ? `Type d'avis: ${notice.typeAvis}` : "",
    notice?.langue ? `Langue: ${notice.langue}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    idweb: `AFD-${row.id}`,
    url: `${AFD_BASE}/tender/${row.id}`,
    publishedAt,
    deadline,
    objet,
    department: pays,
    acheteur: notice?.acheteur ?? "",
    typeAvis: notice?.typeAvis ? `AFD — ${notice.typeAvis}` : "AFD",
    procedure: notice?.typeAvis ?? "",
    raw,
    source: "afd",
    famille: "mobilité",
  };
}
