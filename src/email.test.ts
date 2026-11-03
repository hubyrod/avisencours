import { describe, expect, test } from "bun:test";
import { digestSubject, ECHEC_SUBJECT, renderDigestHtml, renderEchecHtml, renderWarningHtml, uniqueEmails, type DigestData } from "./email.ts";
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

describe("uniqueEmails", () => {
  test("fusionne, normalise et déduplique les listes de destinataires", () => {
    expect(
      uniqueEmails([
        ["a@x.fr", " B@X.fr "],
        ["b@x.fr", "", "c@x.fr"],
      ]),
    ).toEqual(["a@x.fr", "b@x.fr", "c@x.fr"]);
    expect(uniqueEmails([[], []])).toEqual([]);
  });
});

describe("digestSubject", () => {
  test("accord singulier/pluriel, envoyé même sans nouveauté", () => {
    expect(digestSubject(digest(0))).toBe("Avis en cours — pas de nouvel avis");
    expect(digestSubject(digest(1))).toBe("Avis en cours — 1 nouvel avis");
    expect(digestSubject(digest(3))).toBe("Avis en cours — 3 nouveaux avis");
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

  test("titre vers la fiche interne, annonce officielle à côté ; sans tableau de bord, lien direct", () => {
    const html = renderDigestHtml(digest(1));
    expect(html).toContain('href="https://dashboard.example/avis/26-0"');
    expect(html).toContain('href="https://example.com/0"');
    expect(html).toContain("annonce ↗");
    const sans = renderDigestHtml({ ...digest(1), dashboardUrl: null });
    expect(sans).not.toContain("/avis/26-0");
    expect(sans).toContain('href="https://example.com/0"');
  });
  test("statut de l'équipe sur chaque ligne, échéances sans les avis abandonnés, compte des avis à trier", () => {
    const d = digest(0);
    d.upcoming = [
      { ...stored(1), status_label: "répondu", status_color: "#0e6b51", status_is_rejet: false },
      { ...stored(2), status_label: "on laisse tomber", status_color: "#999", status_is_rejet: true },
      { ...stored(3), status_label: "à évaluer", status_color: "#626d66", status_is_rejet: false },
    ];
    d.untriaged = 12;
    const html = renderDigestHtml(d);
    expect(html).toContain("Échéances sous 14 jours (2)");
    expect(html).toContain("répondu");
    expect(html).not.toContain("Avis 2");
    expect(html).toContain("1 avis abandonné non listé");
    expect(html).toContain("<strong>12 sans statut</strong>");
    expect(html).toContain("à trier sur le tableau de bord");
    // Tout abandonné : la section le dit plutôt que « aucune échéance ».
    const tous = renderDigestHtml({ ...d, upcoming: [d.upcoming[1]!] });
    expect(tous).toContain("ont été abandonnés");
    expect(renderDigestHtml({ ...d, untriaged: 0 })).not.toContain("sans statut");
  });
  test("inclut le lien tableau de bord, vers les derniers repérés", () => {
    expect(renderDigestHtml(digest(2))).toContain('href="https://dashboard.example/?tri=recents"');
    expect(renderDigestHtml({ ...digest(2), dashboardUrl: "https://dashboard.example/" })).toContain('href="https://dashboard.example/?tri=recents"');
  });
});

describe("incident et échec pour le lecteur", () => {
  test("incident expliqué au lecteur, jamais l'avertissement technique brut", () => {
    const d = digest(0);
    d.warning = "Marchés Online (Le Moniteur) indisponible — Error: 403 Forbidden sur https://x — ses avis ne sont pas mis à jour ce run";
    d.incident = { pannes: [{ source: "marchesonline", label: "Marchés Online (Le Moniteur)", since: new Date("2026-10-10T04:30:00Z"), conserves: 3 }], llm: false };
    const html = renderDigestHtml(d);
    expect(html).toContain("Mise à jour partielle : Marchés Online (Le Moniteur) ne répond pas");
    expect(html).toContain("depuis le 10 octobre 2026");
    expect(html).toContain("3 avis pertinents concernés");
    expect(html).toContain("L'équipe technique est prévenue.");
    expect(html).not.toContain("403 Forbidden");
    expect(renderDigestHtml({ ...d, incident: null })).not.toContain("ne répond pas");
  });
  test("email d'échec aux utilisateurs", () => {
    const html = renderEchecHtml("mardi 3 novembre 2026", new Date("2026-11-02T04:32:00Z"), "à midi, puis demain matin", "https://dashboard.example");
    expect(html).toContain("Mise à jour non effectuée — mardi 3 novembre 2026");
    expect(html).toContain("n'a pas pu être effectuée");
    expect(html).toContain("2 novembre 2026");
    expect(html).toContain("à midi, puis demain matin");
    expect(html).toContain('href="https://dashboard.example"');
    expect(ECHEC_SUBJECT).toContain("mise à jour non effectuée");
  });
});

describe("renderWarningHtml", () => {
  test("coupe-circuit LLM : titre et conseil OpenRouter", () => {
    const html = renderWarningHtml("coupe-circuit LLM ouvert : clé refusée", null, "lundi 1 septembre 2026");
    expect(html).toContain("Classification LLM interrompue");
    expect(html).toContain("crédit OpenRouter");
    expect(html).not.toContain("achatpublic.com n'a pas répondu");
  });
  test("achatpublic indisponible : mise à jour partielle", () => {
    const html = renderWarningHtml("achatpublic.com indisponible — Error: 503 — veille BOAMP seule pour ce run", null, "lundi");
    expect(html).toContain("Mise à jour partielle");
    expect(html).toContain("n'a pas répondu");
    expect(html).not.toContain("crédit OpenRouter");
  });
});
