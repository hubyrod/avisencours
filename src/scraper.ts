import { buildApiUrl, type SearchParams } from "./params.ts";
import type { Famille } from "./familles.ts";
import { mapConcurrent } from "./concurrent.ts";
import { fetchWithRetry, type FetchLike } from "./http.ts";

export type Announcement = {
  idweb: string;
  url: string;
  publishedAt: string;
  deadline: string | null;
  objet: string;
  department: string;
  acheteur: string;
  typeAvis: string;
  procedure: string;
  raw: string;
  // Provenance et famille de veille (src/familles.ts). BOAMP = mobilité.
  source: Source;
  famille: Famille;
};

export type Source = "boamp" | "achatpublic" | "afd" | "maximilien" | "ampa" | "marchesonline";


type OdsRecord = {
  idweb?: string;
  url_avis?: string;
  objet?: string;
  nomacheteur?: string;
  code_departement?: string;
  dateparution?: string;
  datelimitereponse?: string;
  datefindiffusion?: string;
  nature_libelle?: string;
  etat?: string;
  procedure_libelle?: string;
  descripteur_libelle?: string;
  donnees?: string;
  gestion?: string;
};

type OdsResponse = { total_count: number; results: OdsRecord[] };

export type ScrapeOptions = {
  maxPages?: number;
  pageSize?: number;
  // Pages lues en parallèle après la première (qui donne le total). L'API
  // ODS accepte quelques requêtes simultanées ; un 429 est réessayé avec
  // attente (fetchWithRetry), pas abandonné.
  concurrency?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  // Appelé à chaque page reçue (dans l'ordre d'arrivée, pas de numéro) : le
  // premier argument compte les pages lues, le dernier le total annoncé.
  onPage?: (pagesDone: number, items: Announcement[], totalPages: number) => void;
};

const DEFAULT_CONCURRENCY = 4;

async function fetchPage(params: SearchParams, start: number, rows: number, opts: ScrapeOptions): Promise<OdsResponse> {
  const url = buildApiUrl({ ...params, start, rows });
  const { text } = await fetchWithRetry("API", url, { method: "GET" }, { fetchImpl: opts.fetchImpl, sleep: opts.sleep, timeoutMs: 60_000 });
  return JSON.parse(text) as OdsResponse;
}

// Première page en séquence (elle annonce total_count), puis les suivantes en
// parallèle borné ; les avis sont restitués dans l'ordre des pages.
export async function scrapeAll(
  params: SearchParams,
  opts: ScrapeOptions = {},
): Promise<Announcement[]> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const pageSize = opts.pageSize ?? 100;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  if (maxPages < 1) return [];
  const first = await fetchPage(params, 0, pageSize, opts);
  const firstItems = (first.results ?? []).map(toAnnouncement);
  if (firstItems.length === 0) return [];
  const totalPages = Math.max(1, Math.ceil(first.total_count / pageSize));
  let pagesDone = 1;
  opts.onPage?.(pagesDone, firstItems, totalPages);

  // Dernière page atteinte : total annoncé couvert, ou page incomplète.
  const remaining = firstItems.length < pageSize ? 0 : Math.min(totalPages, maxPages) - 1;
  const starts = Array.from({ length: Math.max(0, remaining) }, (_, i) => (i + 1) * pageSize);
  const pages = await mapConcurrent(
    starts,
    async (start) => {
      const data = await fetchPage(params, start, pageSize, opts);
      const items = (data.results ?? []).map(toAnnouncement);
      opts.onPage?.(++pagesDone, items, totalPages);
      return items;
    },
    concurrency,
  );
  return [...firstItems, ...pages.flat()];
}
function toAnnouncement(f: OdsRecord): Announcement {
  const idweb = f.idweb ?? "";

  let typeAvis = f.nature_libelle ?? "";
  if (f.etat === "RECTIFICATIF") typeAvis += " - rectificatif";
  else if (f.etat === "ANNULATION") typeAvis += " - annulation";
  else if (f.etat === "RECTIFANNUL") typeAvis += " - rectif/annul";
  typeAvis = typeAvis.trim();

  const deadline = f.datelimitereponse ? formatDeadline(f.datelimitereponse) : null;
  const publishedAt = f.dateparution ? formatDate(f.dateparution) : "";

  const donnees = safeJson(f.donnees);
  const gestion = safeJson(f.gestion);
  const objetComplet = pick(donnees, ["OBJET", "OBJET_COMPLET"]);
  const titreMarche = pick(donnees, ["OBJET", "TITRE_MARCHE"]);
  const resumeObjet = pick(gestion, ["INDEXATION", "RESUME_OBJET"]);

  const raw = [
    f.objet,
    titreMarche,
    objetComplet,
    resumeObjet,
    f.nomacheteur ? `Acheteur: ${f.nomacheteur}` : "",
    f.code_departement ? `Département: ${f.code_departement}` : "",
    typeAvis ? `Type d'avis: ${typeAvis}` : "",
    f.procedure_libelle ? `Procédure: ${f.procedure_libelle}` : "",
  ]
    .filter(Boolean)
    .join(" — ");

  return {
    idweb,
    url: f.url_avis ?? "",
    publishedAt,
    deadline,
    objet: f.objet ?? "",
    department: f.code_departement ?? "",
    acheteur: f.nomacheteur ?? "",
    typeAvis,
    procedure: f.procedure_libelle ?? "",
    raw,
    source: "boamp",
    famille: "mobilité",
  };
}

function safeJson(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pick(obj: Record<string, unknown> | null, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return "";
    }
  }
  return typeof cur === "string" ? cur : "";
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} à ${hh}h${mi}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
