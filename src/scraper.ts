import { buildApiUrl, type SearchParams } from "./params.ts";

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
};

type OdsFields = {
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

type OdsRecord = { fields: OdsFields };
type OdsResponse = { nhits: number; records: OdsRecord[] };

export type ScrapeOptions = {
  maxPages?: number;
  pageSize?: number;
  onPage?: (pageNum: number, items: Announcement[]) => void;
};

export async function scrapeAll(
  params: SearchParams,
  opts: ScrapeOptions = {},
): Promise<Announcement[]> {
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const pageSize = opts.pageSize ?? 100;

  const all: Announcement[] = [];
  let pageNum = 1;
  let start = 0;

  while (pageNum <= maxPages) {
    const url = buildApiUrl({ ...params, start, rows: pageSize });
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const data = (await res.json()) as OdsResponse;
    const items = data.records.map(toAnnouncement);
    if (items.length === 0) break;

    all.push(...items);
    opts.onPage?.(pageNum, items);

    if (start + items.length >= data.nhits) break;
    if (items.length < pageSize) break;
    start += pageSize;
    pageNum++;
  }

  return all;
}

function toAnnouncement(r: OdsRecord): Announcement {
  const f = r.fields;
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
