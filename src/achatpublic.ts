// Source secondaire : la salle des marchés achatpublic.com (profil d'acheteur
// de nombreuses collectivités — les MAPA sous 90 k€ n'y passent souvent que
// là). Pas d'API : on rejoue le formulaire de recherche « entreprise »
// (POST rechercheCsl.action, 10 cartes par page, « searchCslBean.page » =
// index de page à partir de 0, recherche mémorisée dans le cookie de session),
// sans mot-clé — l'ensemble des consultations ouvertes
// d'une nature de marché tient en ~100 pages — puis on filtre localement par
// famille de mots-clés (src/familles.ts) : la recherche du site travaille en
// sous-chaîne (« vélo » ⊂ « développement »), la nôtre en début de mot.
// Les fiches (ficheCsl.action, publiques) ne sont lues que pour les
// consultations retenues : description, CPV, date d'ouverture.
import { matchKeywords, type FamilleSearch } from "./familles.ts";
import { departementCodes } from "./departements.ts";
import type { Announcement } from "./scraper.ts";
import { errMessage } from "./http.ts";
import { moisCode } from "./mois.ts";

export const ACHATPUBLIC_BASE = "https://www.achatpublic.com";
const SEARCH_URL = `${ACHATPUBLIC_BASE}/sdm/ent2/gen/rechercheCsl.action`;
const FICHE_URL = `${ACHATPUBLIC_BASE}/sdm/ent2/gen/ficheCsl.action?PCSLID=`;
const USER_AGENT = "avis-en-cours (veille marchés publics ; contact : voir DASHBOARD_URL)";
const MARCHE_CODE = { fournitures: "1", services: "2" } as const;

export type Card = {
  pcslid: string;
  objet: string;
  deadline: string | null; // dd/mm/yyyy à HHhMM
  organisme: string;
  reference: string;
  lots: string;
  nature: string;
  procedure: string;
  typeContrat: string;
  lieu: string;
};

export type Fiche = {
  description: string;
  cpv: string;
  ouverture: string; // texte tel quel, ex. « 27 juillet 2026 16:23 »
};

// « 24 », « Sept. 2026 », « 12 : 00 » -> « 24/09/2026 à 12h00 »
export function parseCardDeadline(day: string, monthYear: string, time: string): string | null {
  const my = monthYear.trim().match(/^(\S+)\s+(\d{4})$/);
  const t = time.replace(/\s+/g, "").match(/^(\d{1,2}):(\d{2})$/);
  const d = day.trim().match(/^\d{1,2}$/);
  const mm = my ? moisCode(my[1]!) : null;
  if (!my || !mm || !t || !d) return null;
  const dd = d[0].padStart(2, "0");
  return `${dd}/${mm}/${my[2]} à ${t[1]!.padStart(2, "0")}h${t[2]}`;
}

// Entités nommées rencontrées sur le site (Latin-1). « &iquest; » (¿) y
// remplace une apostrophe mal encodée par les acheteurs : rendue en « ' ».
const ENTITIES: Record<string, string> = {
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", auml: "ä",
  ccedil: "ç", ocirc: "ô", ouml: "ö", icirc: "î", iuml: "ï", ucirc: "û", ugrave: "ù", uuml: "ü",
  oelig: "œ", aelig: "æ", Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À", Acirc: "Â",
  Ccedil: "Ç", Ocirc: "Ô", Icirc: "Î", Ucirc: "Û", Ugrave: "Ù", OElig: "Œ",
  nbsp: " ", quot: '"', apos: "'", iquest: "'", rsquo: "'", lsquo: "'", laquo: "«", raquo: "»",
  hellip: "…", ndash: "–", mdash: "—", euro: "€", deg: "°", lt: "<", gt: ">",
};

// Entités numériques 128–159 : les acheteurs saisissent en Windows-1252 et le
// site les recopie telles quelles (&#140; = Œ, &#156; = œ, &#146; = ’, &#128; = €).
const CP1252: Record<number, string> = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰",
  138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "'", 146: "'", 147: "\"", 148: "\"", 149: "•",
  150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ",
};

function codePoint(n: number): string {
  return CP1252[n] ?? String.fromCodePoint(n);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&([A-Za-z]+);/g, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/&amp;/g, "&");
}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function field(card: string, label: string): string {
  const re = new RegExp(`${label}\\s*(?:&nbsp;)?:\\s*</span\\s*>\\s*(?:<span[^>]*>)?([\\s\\S]*?)</span\\s*>`, "i");
  const m = card.match(re);
  return m ? text(m[1]!) : "";
}

// Découpe une page de résultats en cartes. Tolérant : une carte incomplète
// est ignorée plutôt que de faire échouer la page.
export function parseCards(html: string): Card[] {
  const cards: Card[] = [];
  const re = /<li id="li_consult_(CSL_[A-Za-z0-9_-]+)"([\s\S]*?)(?=<li id="li_consult_|<\/ul>\s*<ul class=" jqSortByBloc|$)/g;
  for (const m of html.matchAll(re)) {
    const pcslid = m[1]!;
    const body = m[2]!;
    const title = body.match(/class="jqCardLink[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!title) continue;
    const day = body.match(/sdmCardConsult__numberTime[^>]*>([^<]*)</);
    const my = body.match(/sdmCardConsult__ddyyyy textLatoReg--14[^>]*>([^<]*)</);
    const hm = body.match(/sdmCardConsult__preciseTime[^>]*>([^<]*)</);
    const lieu = body.match(/class="jqShave lieuExec"[^>]*>([\s\S]*?)<\/span>/);
    cards.push({
      pcslid,
      objet: text(title[1]!),
      deadline: day && my && hm ? parseCardDeadline(day[1]!, my[1]!, hm[1]!) : null,
      organisme: field(body, "Organisme"),
      reference: field(body, "Référence"),
      lots: field(body, "Lots"),
      nature: field(body, "Nature des prestations"),
      procedure: field(body, "Type de procédure"),
      typeContrat: field(body, "Type de contrat"),
      lieu: lieu ? text(lieu[1]!) : "",
    });
  }
  return cards;
}

// « Page 3 / 92 » -> { page: 3, pages: 92 } ; absent = une seule page.
export function parsePagination(html: string): { page: number; pages: number } {
  const m = html.match(/Page\s+(\d+)\s*\/\s*(\d+)/);
  return m ? { page: Number(m[1]), pages: Number(m[2]) } : { page: 1, pages: 1 };
}

export function parseFiche(html: string): Fiche {
  const t = text(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " "));
  const desc = t.match(/Description\s*:\s*(.*?)\s*(?:Code CPV|Date d'ouverture|Date limite de remise)/);
  const cpv = t.match(/Code CPV recherch[ée]\s*:\s*(.*?)\s*(?:Date d'ouverture|Date limite de remise)/);
  const ouv = t.match(/Date d'ouverture de la salle\s*:\s*(.*?)\s*\(heure de Paris\)/);
  return {
    description: desc?.[1]?.trim() ?? "",
    cpv: cpv?.[1]?.trim() ?? "",
    ouverture: ouv?.[1]?.trim() ?? "",
  };
}

// Le site attend ses formulaires en ISO-8859-15 ; nos champs sont ASCII
// (aucun mot-clé envoyé), on l'indique quand même.
function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function todayFr(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export type AchatPublicClient = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultClient: AchatPublicClient = { fetch: (u, i) => fetch(u, i) };

// Cookie de session (PROD_APC_ID) : la pagination est relative à la
// recherche mémorisée côté serveur — sans lui, « page suivante » n'a pas de sens.
class Session {
  cookie = "";
  constructor(private readonly client: AchatPublicClient) {}

  async post(url: string, fields: Record<string, string>): Promise<string> {
    return this.request(url, {
      method: "POST",
      body: formBody(fields),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=ISO-8859-15" },
    });
  }

  async get(url: string): Promise<string> {
    return this.request(url, { method: "GET" });
  }

  private async request(url: string, init: RequestInit): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.client.fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), "user-agent": USER_AGENT, cookie: this.cookie },
          signal: AbortSignal.timeout(30_000),
          redirect: "follow",
        });
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          const m = setCookie.match(/PROD_APC_ID=[^;]+/);
          if (m) this.cookie = m[0];
        }
        const body = await res.text();
        if (!res.ok) throw new Error(`achatpublic ${res.status} ${res.statusText} sur ${url}`);
        return body;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await (this.client.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1000 * attempt);
      }
    }
    throw new Error(`achatpublic injoignable : ${errMessage(lastErr)}`);
  }
}

export type ScrapeAchatPublicOptions = {
  searches: readonly FamilleSearch[];
  maxPages?: number;
  client?: AchatPublicClient;
  log?: (msg: string) => void;
  // Avancement : pages de liste lues / pages annoncées (toutes natures cumulées).
  onPage?: (done: number, total: number | null) => void;
};

export type AchatPublicItem = Announcement & { matchedQueries: string[] };

// Liste toutes les consultations ouvertes d'une nature de marché (une passe de
// pagination), puis les répartit dans les familles de cette nature.
export async function scrapeAchatPublic(opts: ScrapeAchatPublicOptions): Promise<AchatPublicItem[]> {
  const log = opts.log ?? (() => {});
  const maxPages = opts.maxPages ?? 200;
  const client = opts.client ?? defaultClient;
  const out: AchatPublicItem[] = [];
  const natures = [...new Set(opts.searches.map((s) => s.marche))];
  let pagesDone = 0;

  for (const marche of natures) {
    const session = new Session(client);
    const searches = opts.searches.filter((s) => s.marche === marche);
    const base = {
      "searchCslBean.intitule": "",
      "searchCslBean.marche": MARCHE_CODE[marche],
      "searchCslBean.procedure": "-1",
      "searchCslBean.dlrpStart": todayFr(),
    };
    let html = await session.post(SEARCH_URL, { "searchCslBean.initial": "0", ...base });
    let { page, pages } = parsePagination(html);
    const seen = new Set<string>();
    const matched = new Map<string, { card: Card; famille: FamilleSearch["famille"]; keywords: string[] }>();
    let total = 0;
    const pagesBefore = pagesDone;
    while (true) {
      // Total = pages déjà lues (autres natures) + pages annoncées pour celle-ci.
      opts.onPage?.(++pagesDone, pagesBefore + pages);
      const cards = parseCards(html);
      if (cards.length === 0 && page === 1) throw new Error(`achatpublic : aucune carte lue (${marche}) — structure de page changée ?`);
      for (const card of cards) {
        if (seen.has(card.pcslid)) continue;
        seen.add(card.pcslid);
        total++;
        for (const s of searches) {
          const kws = matchKeywords(card.objet, s.keywords);
          if (kws.length > 0 && !matched.has(card.pcslid)) matched.set(card.pcslid, { card, famille: s.famille, keywords: kws });
        }
      }
      if (page >= pages || page >= maxPages) break;
      // Index 0-based : la page courante (1-based) est l'index de la suivante.
      html = await session.post(SEARCH_URL, { ...base, "searchCslBean.page": String(page) });
      const next = parsePagination(html);
      if (next.page !== page + 1) throw new Error(`achatpublic : pagination incohérente (page ${next.page} après ${page}/${pages}, ${marche})`);
      page = next.page;
      pages = next.pages;
    }
    log(`  achatpublic ${marche}: ${total} consultations sur ${page} page(s), ${matched.size} retenue(s)`);

    for (const { card, famille, keywords } of matched.values()) {
      let fiche: Fiche = { description: "", cpv: "", ouverture: "" };
      try {
        fiche = parseFiche(await session.get(`${FICHE_URL}${card.pcslid}&ongletActif=2`));
      } catch (err) {
        log(`  fiche ${card.pcslid} illisible : ${errMessage(err)}`);
      }
      out.push({ ...toAnnouncement(card, fiche, famille), matchedQueries: keywords });
    }
  }
  return out;
}

// Au-delà de ce nombre de départements listés, l'acheteur a coché « toute la
// France » : on ne stocke pas la liste (et le filtre par département la garde).
const MAX_DEPARTEMENTS = 15;

export function toAnnouncement(card: Card, fiche: Fiche, famille: FamilleSearch["famille"]): Announcement {
  const codes = departementCodes(card.lieu);
  const department = codes.length > MAX_DEPARTEMENTS ? "France entière" : codes.join(", ");
  const raw = [
    card.objet,
    fiche.description && fiche.description !== card.objet ? fiche.description : "",
    fiche.cpv ? `CPV: ${fiche.cpv}` : "",
    card.organisme ? `Acheteur: ${card.organisme}` : "",
    card.lieu ? `Lieu: ${card.lieu}` : "",
    card.nature ? `Nature: ${card.nature}` : "",
    card.procedure ? `Procédure: ${card.procedure}` : "",
    card.typeContrat ? `Contrat: ${card.typeContrat}` : "",
    card.lots ? `Lots: ${card.lots}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    idweb: card.pcslid,
    url: `${FICHE_URL}${card.pcslid}&ongletActif=2`,
    publishedAt: fiche.ouverture,
    deadline: card.deadline,
    objet: card.objet,
    department,
    acheteur: card.organisme,
    typeAvis: `Consultation achatpublic (${card.nature || "?"})`,
    procedure: card.procedure,
    raw,
    source: "achatpublic",
    famille,
  };
}
