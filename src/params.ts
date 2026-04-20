export type SearchParams = {
  query: string;
  typeMarche?: string[];
  codeDepartement?: string[];
  sort?: string;
  deadlineFrom?: string;
  start?: number;
  rows?: number;
};

const API_URL = Bun.env.PORTAL_API_URL;
const DATASET = Bun.env.PORTAL_DATASET;
if (!API_URL) {
  throw new Error("PORTAL_API_URL is required — set it in .env (see .env.example)");
}
if (!DATASET) {
  throw new Error("PORTAL_DATASET is required — set it in .env (see .env.example)");
}

function enc(s: string): string {
  return encodeURIComponent(s).replace(/%28/g, "(").replace(/%29/g, ")");
}

export function buildApiUrl(p: SearchParams): string {
  const parts: string[] = [`dataset=${enc(DATASET!)}`];
  parts.push(`q=${enc(p.query)}`);
  if (p.rows) parts.push(`rows=${p.rows}`);
  if (p.start && p.start > 0) parts.push(`start=${p.start}`);
  if (p.sort) parts.push(`sort=${enc(p.sort)}`);
  for (const tm of p.typeMarche ?? []) parts.push(`refine.type_marche=${enc(tm)}`);
  for (const cd of p.codeDepartement ?? []) parts.push(`refine.code_departement=${enc(cd)}`);
  if (p.deadlineFrom) {
    const d = p.deadlineFrom;
    const expr =
      `(NOT #null(datelimitereponse) AND datelimitereponse>="${d}") ` +
      `OR (#null(datelimitereponse) AND datefindiffusion>="${d}")`;
    parts.push(`q.filtre_etat=${enc(expr)}`);
  }
  return `${API_URL}?${parts.join("&")}`;
}
