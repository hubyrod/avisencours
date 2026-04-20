export type SearchParams = {
  query: string;
  typeMarche?: string[];
  descripteurCodes?: number[];
  codeDepartement?: string[];
  typeAvis?: string[];
  famille?: string[];
  sort?: string;
  deadlineFrom?: string;
  disjunctiveFacets?: string[];
  start?: number;
};

const BASE = Bun.env.PORTAL_BASE_URL;
if (!BASE) {
  throw new Error("PORTAL_BASE_URL is required — set it in .env (see .env.example)");
}

function enc(s: string): string {
  return encodeURIComponent(s).replace(/%28/g, "(").replace(/%29/g, ")");
}

export function buildSearchUrl(p: SearchParams): string {
  const parts: string[] = [];
  const add = (k: string, v = "") => parts.push(v === "" ? `${k}=` : `${k}=${enc(v)}`);

  for (const f of p.disjunctiveFacets ?? []) add(`disjunctive.${f}`);
  if (p.sort) add("sort", p.sort);
  add("q", p.query);
  for (const t of p.typeMarche ?? []) add("refine.type_marche", t);
  for (const dc of p.descripteurCodes ?? []) add("refine.dc", String(dc));
  for (const cd of p.codeDepartement ?? []) add("refine.code_departement", cd);
  for (const ta of p.typeAvis ?? []) add("refine.type_avis", ta);
  for (const f of p.famille ?? []) add("refine.famille", f);
  if (p.start && p.start > 0) add("start", String(p.start));
  if (p.deadlineFrom) {
    const d = p.deadlineFrom;
    const expr =
      `(NOT #null(datelimitereponse) AND datelimitereponse>="${d}") ` +
      `OR (#null(datelimitereponse) AND datefindiffusion>="${d}")`;
    add("q.filtre_etat", expr);
  }

  return `${BASE}?${parts.join("&")}#resultarea`;
}
