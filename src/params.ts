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
  return encodeURIComponent(s);
}

function parseQueryTerms(query: string): string[] {
  return query
    .split(/\s+OR\s+/)
    .map((t) => t.trim().replace(/^"([^"]*)"$/, "$1"))
    .filter(Boolean);
}

function searchClause(terms: string[]): string {
  const exprs = terms.map((t) => `search(*, "${t.replace(/"/g, '\\"')}")`);
  return exprs.length === 1 ? exprs[0]! : `(${exprs.join(" OR ")})`;
}

function deadlineClause(d: string): string {
  return (
    `((datelimitereponse IS NOT NULL AND datelimitereponse>=date'${d}')` +
    ` OR (datelimitereponse IS NULL AND datefindiffusion>=date'${d}'))`
  );
}

export function buildApiUrl(p: SearchParams): string {
  const parts: string[] = [];
  if (p.rows) parts.push(`limit=${p.rows}`);
  if (p.start && p.start > 0) parts.push(`offset=${p.start}`);
  if (p.sort) parts.push(`order_by=${enc(p.sort)}`);
  for (const tm of p.typeMarche ?? []) parts.push(`refine=${enc(`type_marche:${tm}`)}`);
  for (const cd of p.codeDepartement ?? []) parts.push(`refine=${enc(`code_departement:${cd}`)}`);

  const clauses: string[] = [];
  if (p.query) clauses.push(searchClause(parseQueryTerms(p.query)));
  if (p.deadlineFrom) clauses.push(deadlineClause(p.deadlineFrom));
  if (clauses.length > 0) parts.push(`where=${enc(clauses.join(" AND "))}`);

  return `${API_URL}/${DATASET}/records?${parts.join("&")}`;
}
