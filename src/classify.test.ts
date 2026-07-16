import { describe, expect, test } from "bun:test";
import { classify } from "./classify.ts";
import type { Announcement } from "./scraper.ts";

function avis(objet: string, typeAvis = "Avis de marché"): Announcement {
  return {
    idweb: "test-1",
    url: "https://example.com/avis/1",
    publishedAt: "1 juillet 2026",
    deadline: null,
    objet,
    department: "75",
    acheteur: "Ville test",
    typeAvis,
    procedure: "Procédure adaptée",
    raw: objet,
  };
}

describe("classify", () => {
  test("études de mobilité restent relevant", () => {
    const r = classify(avis("Schéma directeur cyclable départemental et études de faisabilité"));
    expect(r.category).toBe("relevant");
  });

  test("MOE part en travaux", () => {
    const r = classify(avis("Mission de maîtrise d'œuvre pour la réalisation d'une liaison cyclable"));
    expect(r.category).toBe("travaux");
  });

  test("AMO pour création d'ouvrage physique part en travaux", () => {
    const r = classify(
      avis("Assistance à maîtrise d'ouvrage relative à la création d'une passerelle piétonne"),
    );
    expect(r.category).toBe("travaux");
  });

  test("AMO pour élaboration d'un plan reste relevant", () => {
    const r = classify(avis("Assistance à maîtrise d'ouvrage pour l'élaboration du plan de mobilité"));
    expect(r.category).toBe("relevant");
  });

  test("téléphonie est exclue", () => {
    const r = classify(avis("Fourniture de services de téléphonie pour la collectivité"));
    expect(r.category).toBe("excluded");
    expect(r.reason).toContain("télécom");
  });

  test("contrôle de travaux est exclu", () => {
    const r = classify(avis("Mission de contrôle des travaux de voirie"));
    expect(r.category).toBe("excluded");
  });

  test("contrôle qualité de service est exclu", () => {
    const r = classify(avis("Contrôle de la qualité de service du réseau de transport urbain"));
    expect(r.category).toBe("excluded");
  });

  test("la casse et les accents sont normalisés", () => {
    const r = classify(avis("RÉNOVATION DU GROUPE SCOLAIRE"));
    expect(r.category).not.toBe("relevant");
  });
});
