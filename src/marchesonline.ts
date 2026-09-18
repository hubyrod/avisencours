// Source secondaire : Marchés Online (marchesonline.com, groupe Le Moniteur),
// agrégateur d'avis « en accès libre ». Pas de compte nécessaire pour ce que
// l'on utilise : les pages par mot-clé (« /appels-offres/top-recherches/<mot> »,
// 20 avis par page, « ?page=N ») et les fiches (texte complet de l'avis). Les
// « profils de recherche » et alertes du site demandent un compte et sont
// limités à 5 : on les remplace par un parcours de chaque mot-clé de la veille,
// puis un filtre local (nature via le libellé d'activité de la carte, mots-clés
// en début de mot sur l'intitulé — la recherche du site est lexicale :
// « mobilité » y ramène « téléphonie mobile »). La fiche n'est lue que pour les
// avis retenus (descriptif, CPV, acheteur).
import { matchKeywords, type FamilleSearch } from "./familles.ts";
import { classify } from "./classify.ts";
import type { Announcement } from "./scraper.ts";
import { errMessage } from "./http.ts";

export const MARCHESONLINE_BASE = "https://www.marchesonline.com";
const USER_AGENT = "avis-en-cours (veille marchés publics)";
const PAGE_SIZE = 20;

export type MoCard = {
  id: string; // identifiant numérique de l'avis (ao-<id>-<version>)
  path: string; // chemin de la fiche
  numero: string; // « AO-2639-5253 »
  objet: string;
  acheteur: string;
  departement: string;
  ville: string;
  activite: string; // « Services », « Etudes, Maîtrise d'oeuvre, Contrôle », « Fournitures »…
  procedure: string;
  publie: string; // dd/mm/yyyy
  deadline: string | null; // dd/mm/yyyy
};

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

// « mobilité » -> « mobilite », « voie verte » -> « voie-verte » (forme des URL du site).
export function keywordSlug(term: string): string {
  return term
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function listUrl(term: string, page: number): string {
  return `${MARCHESONLINE_BASE}/appels-offres/top-recherches/${keywordSlug(term)}${page > 1 ? `?page=${page}` : ""}`;
}

// « : 176 avis » / « 17 012 avis » -> 176 / 17012 ; absent -> null.
export function parseCount(html: string): number | null {
  const m = html.match(/(\d[\d   ]*)\s*avis\s*</);
  return m ? Number(m[1]!.replace(/\D/g, "")) : null;
}

export function parseCards(html: string): MoCard[] {
  const cards: MoCard[] = [];
  // La page contient aussi l'ancienne carte en commentaire HTML : on ne lit
  // que les blocs « box-shadow-neutral-2 », hors commentaires.
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const block of live.split(/<div class="mt-6 box-shadow-neutral-2/).slice(1)) {
    const link = block.match(/href="(\/appels-offres\/avis\/[^"]+\/ao-(\d+)-\d+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const lieu = block.match(/href="\/appels-offres\/lieu\/[^"]*"[\s\S]*?<span class="ml-2">([\s\S]*?)<\/span>/);
    const lieuText = lieu ? line(lieu[1]!) : "";
    const lieuParts = lieuText.match(/^(\d{2,3}|2A|2B)\s*-\s*(.*)$/);
    cards.push({
      id: link[2]!,
      path: link[1]!,
      numero: block.match(/\b(AO-\d{4}-\d{4})\b/)?.[1] ?? "",
      objet: line(link[3]!),
      acheteur: line(block.match(/href="\/appels-offres\/acheteurs\/[^"]*">([\s\S]*?)<\/a>/)?.[1] ?? ""),
      departement: lieuParts?.[1] ?? "",
      ville: lieuParts ? lieuParts[2]!.trim() : lieuText,
      activite: line(block.match(/v-if="item\.domainOfActivity"[\s\S]*?<span class="ml-2">([\s\S]*?)<\/span>/)?.[1] ?? ""),
      procedure: line(block.match(/v-if="item\.procedure"[\s\S]*?<span class="ml-2">([\s\S]*?)<\/span>/)?.[1] ?? ""),
      publie: block.match(/Mise en ligne\s*:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? "",
      deadline: block.match(/Limite de réponse\s*:\s*(?:<[^>]*>\s*)*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null,
    });
  }
  return cards;
}

export type MoFiche = { descriptif: string; cpv: string };

export function parseFiche(html: string): MoFiche {
  const i = html.indexOf('id="print_area"');
  if (i < 0) return { descriptif: "", cpv: "" };
  const area = html.slice(i, i + 200_000).replace(/<script[\s\S]*?<\/script>/g, " ");
  const end = area.search(/id="print_area_footer"|<footer|Ces recherches peuvent vous intéresser/);
  const text = line(end > 0 ? area.slice(0, end) : area)
    .replace(/^.*?Descriptif\s*(?:Source\s*:\s*\S+\s*)?/, "")
    .trim();
  const cpv = text.match(/(?:Nomenclature principale \(cpv\)|Code CPV principal|CPV)\s*:?\s*(\d{8}(?:[^0-9]{0,80})?)/)?.[1]?.trim() ?? "";
  return { descriptif: text.slice(0, 3000), cpv };
}

export type MarchesOnlineClient = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};
const defaultClient: MarchesOnlineClient = { fetch: (u, i) => fetch(u, i) };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Le site est derrière Cloudflare et bloque l'adresse (429 « cf-mitigated:
// challenge », pendant de longues minutes) après quelques centaines de
// requêtes rapides : une pause entre chaque requête, et sur 429 on attend
// Retry-After (ou 30 s, 60 s, 90 s) avant de réessayer.
const PAUSE_MS = 1200;

async function get(client: MarchesOnlineClient, url: string): Promise<string> {
  const sleep = client.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await client.fetch(url, {
        headers: { "user-agent": USER_AGENT, "accept-language": "fr" },
        redirect: "follow",
        signal: AbortSignal.timeout(45_000),
      });
      const body = await res.text();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000 * attempt));
        lastErr = new Error(`Marchés Online 429 Too Many Requests sur ${url.slice(0, 90)}`);
        continue;
      }
      if (!res.ok) throw new Error(`Marchés Online ${res.status} ${res.statusText} sur ${url.slice(0, 90)}`);
      await sleep(PAUSE_MS);
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Marchés Online injoignable : ${errMessage(lastErr)}`);
}

// Nature demandée par la famille -> libellés d'activité du site.
function natureMatches(marche: FamilleSearch["marche"], activite: string): boolean {
  const a = activite
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return marche === "fournitures" ? /fourniture/.test(a) : /service|etude|assistance|concours|autres/.test(a);
}

export type ScrapeMarchesOnlineOptions = {
  searches: readonly FamilleSearch[];
  maxPagesPerKeyword?: number;
  client?: MarchesOnlineClient;
  log?: (msg: string) => void;
};

export type MarchesOnlineItem = Announcement & { matchedQueries: string[] };

export async function scrapeMarchesOnline(opts: ScrapeMarchesOnlineOptions): Promise<MarchesOnlineItem[]> {
  const log = opts.log ?? (() => {});
  const client = opts.client ?? defaultClient;
  // Les pages sont triées par date de publication décroissante : plafonner
  // les pages par mot-clé revient à ne lire que les avis les plus récents des
  // mots-clés très larges (« transport », « échange » : 50 pages chacun). Un
  // avis ancien au-delà du plafond sort du tableau de bord (non revu au run).
  const maxPages = opts.maxPagesPerKeyword ?? 8;
  const terms = [...new Set(opts.searches.flatMap((s) => s.keywords))];

  const seen = new Set<string>();
  const matched = new Map<string, { card: MoCard; famille: FamilleSearch["famille"]; keywords: string[] }>();
  let pages = 0;
  let total = 0;
  for (const term of terms) {
    let count: number | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const html = await get(client, listUrl(term, page));
      pages++;
      if (page === 1) {
        count = parseCount(html);
        if (count === null && !/Aucun avis pour cette recherche/.test(html)) {
          throw new Error(`Marchés Online : page « ${term} » illisible — structure changée ?`);
        }
      }
      const cards = parseCards(html);
      if (cards.length === 0) break;
      for (const card of cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        total++;
        for (const s of opts.searches) {
          if (!natureMatches(s.marche, card.activite)) continue;
          const kws = matchKeywords(card.objet, s.keywords);
          if (kws.length > 0 && !matched.has(card.id)) matched.set(card.id, { card, famille: s.famille, keywords: kws });
        }
      }
      if (count !== null && page * PAGE_SIZE >= count) break;
    }
  }
  log(`  Marchés Online: ${total} avis distincts sur ${pages} page(s) (${terms.length} mots-clés), ${matched.size} retenu(s)`);

  // La fiche (descriptif, CPV) n'est lue que si l'intitulé seul ne suffit pas
  // déjà aux règles regex pour exclure l'avis (« transport scolaire »,
  // « autocar », « assainissement »… : la majorité des retenus) — le classement
  // final redonnera le même verdict sur ce texte réduit.
  const out: MarchesOnlineItem[] = [];
  let fiches = 0;
  for (const { card, famille, keywords } of matched.values()) {
    let fiche: MoFiche = { descriptif: "", cpv: "" };
    const titleOnly = toAnnouncement(card, fiche, famille);
    if (famille !== "mobilité" || classify(titleOnly).category !== "excluded") {
      try {
        fiche = parseFiche(await get(client, `${MARCHESONLINE_BASE}${card.path}`));
        fiches++;
      } catch (err) {
        log(`  fiche Marchés Online ${card.id} illisible : ${errMessage(err)}`);
      }
    }
    out.push({ ...toAnnouncement(card, fiche, famille), matchedQueries: keywords });
  }
  log(`  Marchés Online: ${fiches} fiche(s) lue(s)`);
  return out;
}

// Libellé d'activité du site -> nature courte. « Etudes, Maîtrise d'oeuvre,
// Contrôle » ne doit surtout pas entrer tel quel dans le texte classé : le
// motif « maîtrise d'oeuvre » y ferait basculer toute étude en travaux.
export function natureLabel(activite: string): string {
  const a = activite
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/etude/.test(a)) return "Études";
  if (/fourniture/.test(a)) return "Fournitures";
  if (/service/.test(a)) return "Services";
  if (/travaux/.test(a)) return "Travaux";
  return activite;
}

export function toAnnouncement(card: MoCard, fiche: MoFiche, famille: FamilleSearch["famille"]): Announcement {
  const raw = [
    card.objet,
    fiche.descriptif,
    fiche.cpv ? `CPV: ${fiche.cpv}` : "",
    card.acheteur ? `Acheteur: ${card.acheteur}` : "",
    card.departement || card.ville ? `Lieu: ${[card.departement, card.ville].filter(Boolean).join(" - ")}` : "",
    card.activite ? `Nature: ${natureLabel(card.activite)}` : "",
    card.procedure ? `Procédure: ${card.procedure}` : "",
    card.numero ? `Avis: ${card.numero}` : "",
  ]
    .filter(Boolean)
    .join(" — ");
  return {
    idweb: `MO-${card.id}`,
    url: `${MARCHESONLINE_BASE}${card.path}`,
    publishedAt: card.publie,
    deadline: card.deadline,
    objet: card.objet,
    department: card.departement,
    acheteur: card.acheteur,
    typeAvis: `Avis Marchés Online${card.activite ? ` (${natureLabel(card.activite)})` : ""}`,
    procedure: card.procedure,
    raw,
    source: "marchesonline",
    famille,
  };
}
