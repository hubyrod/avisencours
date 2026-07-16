import { describe, expect, test } from "bun:test";
import { digestSubject, renderDigestHtml, type DigestData } from "./email.ts";
import type { StoredAnnouncement } from "./db.ts";

function stored(n: number, objet = `Avis ${n}`): StoredAnnouncement {
  return {
    idweb: `26-${n}`,
    url: `https://example.com/${n}`,
    objet,
    acheteur: "Ville test",
    department: "75",
    type_avis: "Avis de marché",
    procedure: null,
    published_at: "1 juillet 2026",
    deadline: null,
    deadline_text: "01/09/2026 à 12h00",
    category: "relevant",
    reason: null,
    first_seen_run_id: 1,
  };
}

function digest(newCount: number): DigestData {
  return {
    newRelevant: Array.from({ length: newCount }, (_, i) => stored(i)),
    upcoming: [],
    totalRelevant: 46,
    totalTravaux: 472,
    dashboardUrl: "https://dashboard.example",
    dateStr: "mercredi 16 juillet 2026",
  };
}

describe("digestSubject", () => {
  test("accord singulier/pluriel", () => {
    expect(digestSubject(digest(0))).toContain("rien de nouveau");
    expect(digestSubject(digest(1))).toContain("1 nouvel avis pertinent");
    expect(digestSubject(digest(3))).toContain("3 nouveaux avis pertinents");
  });
});

describe("renderDigestHtml", () => {
  test("plafonne chaque section à 30 lignes avec un lien vers le reste", () => {
    const html = renderDigestHtml(digest(35));
    expect(html).toContain("… et 5 autres avis");
  });

  test("échappe le HTML des objets", () => {
    const d = digest(0);
    d.newRelevant = [stored(1, `<script>alert("x")</script>`)];
    const html = renderDigestHtml(d);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("inclut le lien tableau de bord", () => {
    expect(renderDigestHtml(digest(2))).toContain("https://dashboard.example");
  });
});
