import type { Announcement } from "./scraper.ts";

export type Matched = Announcement & { matchedQueries: string[]; reason?: string };

type ReportMeta = {
  title: string;
  subtitle: string;
  generatedAt: string;
};

export function renderMarkdown(items: Matched[], meta: ReportMeta): string {
  const sorted = [...items].sort((a, b) => {
    const ad = parseDeadline(a.deadline);
    const bd = parseDeadline(b.deadline);
    if (ad && bd) return ad.getTime() - bd.getTime();
    if (ad) return -1;
    if (bd) return 1;
    return 0;
  });

  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  lines.push("");
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Total: ${sorted.length} avis`);
  lines.push("");
  lines.push(meta.subtitle);
  lines.push("");

  for (const it of sorted) {
    const title = it.objet || "(objet non extrait)";
    lines.push(`## ${title}`);
    lines.push("");
    const bullets: string[] = [];
    bullets.push(`- **Avis n°** ${it.idweb}`);
    bullets.push(`- **Acheteur** ${it.acheteur || "?"}`);
    bullets.push(`- **Département** ${it.department || "?"}`);
    if (it.deadline) bullets.push(`- **Date limite** ${it.deadline}`);
    bullets.push(`- **Publié le** ${it.publishedAt || "?"}`);
    if (it.typeAvis) bullets.push(`- **Type d'avis** ${it.typeAvis}`);
    if (it.procedure) bullets.push(`- **Procédure** ${it.procedure}`);
    bullets.push(`- **Mots-clés trouvés** ${it.matchedQueries.join(", ")}`);
    if (it.reason) bullets.push(`- **Classement** ${it.reason}`);
    bullets.push(`- [Voir l'avis](${it.url})`);
    lines.push(bullets.join("\n"));
    lines.push("");
  }

  return lines.join("\n");
}

function parseDeadline(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
}
