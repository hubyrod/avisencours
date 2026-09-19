import { describe, expect, test } from "bun:test";
import { decouperRaw, estEforms, structurerTexte } from "./avis-texte.ts";

describe("decouperRaw", () => {
  test("BOAMP : objet répété écarté, description gardée, étiquettes connues ignorées", () => {
    const objet = "Élaboration du plan de mobilité simplifié";
    const raw = `${objet} — ${objet} — Étude en trois phases : diagnostic, scénarios, plan d'actions. — Acheteur: CC du Val — Département: 26 — Type d'avis: Avis de marché — Procédure: MAPA`;
    expect(decouperRaw(raw, objet)).toEqual({
      description: ["Étude en trois phases : diagnostic, scénarios, plan d'actions."],
      precisions: [],
    });
  });
  test("achatpublic / Maximilien : CPV, lieu, lots deviennent des précisions", () => {
    const objet = "Étude de circulation";
    const raw = `${objet} — Le présent marché porte sur… — CPV: 71311200 - Conseil en transport — Acheteur: Ville — Lieu: Gard — Nature: Services — Contrat: Accord-cadre — Lots: 2`;
    expect(decouperRaw(raw, objet)).toEqual({
      description: ["Le présent marché porte sur…"],
      precisions: [["CPV", "71311200 - Conseil en transport"], ["Lieu", "Gard"], ["Contrat", "Accord-cadre"], ["Lots", "2"]],
    });
  });
  test("texte vide ou absent", () => {
    expect(decouperRaw(null, "x")).toEqual({ description: [], precisions: [] });
    expect(decouperRaw("x", "x")).toEqual({ description: [], precisions: [] });
  });
});

describe("structurerTexte (eForms aplati)", () => {
  const texte =
    "1. Acheteur 1.1 Acheteur Nom officiel: IRCEM agirc-arrco Forme juridique de l'acheteur: Organisme de droit public, contrôlé par une autorité publique centrale Activité du pouvoir adjudicateur: Protection sociale 2. Procédure 2.1 Procédure Titre: Mise en oeuvre d'une offre de service territoriale pour préserver la mobilité des seniors Description: Via le présent marché, le Groupe IRCEM souhaite confier au Titulaire la conception, l'organisation et l'animation d'une offre de service territoriale. Identifiant de la procédure: 17745041-a59b Type de procédure: Ouverte La procédure est accélérée: non 2.1.1 Objet Nature principale du marché: Services Nomenclature principale (cpv): 85000000 Services de santé et services sociaux 2.1.3 Valeur Valeur estimée hors TVA: 0 Euro 2.1.4 Informations générales Base juridique: Directive 2014/24/UE 5.1.12 Conditions du marché public Date limite de réception des offres: 21/09/2026 12:00 +02:00 Durée de validité";
  test("sections, titres, champs et résumé", () => {
    const s = structurerTexte(texte)!;
    expect(s).not.toBeNull();
    expect(s.sections.map((x) => `${x.numero} ${x.titre}`)).toEqual([
      "1 Acheteur",
      "1.1 Acheteur",
      "2 Procédure",
      "2.1 Procédure",
      "2.1.1 Objet",
      "2.1.3 Valeur",
      "2.1.4 Informations générales",
      "5.1.12 Conditions du marché public",
    ]);
    expect(s.sections[1]!.champs).toEqual([
      { label: "Nom officiel", valeur: "IRCEM agirc-arrco" },
      { label: "Forme juridique de l'acheteur", valeur: "Organisme de droit public, contrôlé par une autorité publique centrale" },
      { label: "Activité du pouvoir adjudicateur", valeur: "Protection sociale" },
    ]);
    expect(s.sections[3]!.champs.map((c) => c.label)).toEqual(["Titre", "Description", "Identifiant de la procédure", "Type de procédure", "La procédure est accélérée"]);
    // « 0 Euro » n'ouvre pas une section ; la valeur reste entière.
    expect(s.sections[5]!.champs).toEqual([{ label: "Valeur estimée hors TVA", valeur: "0 Euro" }]);
    expect(s.sections[7]!.champs[0]).toEqual({ label: "Date limite de réception des offres", valeur: "21/09/2026 12:00 +02:00 Durée de validité" });
    const long = structurerTexte("1. Acheteur Nom officiel: X 5.1.12 Conditions Soumission par voie électronique: Autorisée Langues dans lesquelles les offres ou demandes de participation/candidatures peuvent être présentées: français Variantes: Non autorisée")!;
    expect(long.sections[1]!.champs.map((c) => c.label)).toEqual(["Soumission par voie électronique", "Langues dans lesquelles les offres ou demandes de participation/candidatures peuvent être présentées", "Variantes"]);
    expect(s.resume).toBe("Via le présent marché, le Groupe IRCEM souhaite confier au Titulaire la conception, l'organisation et l'animation d'une offre de service territoriale.");
  });
  test("texte libre : pas de structure", () => {
    expect(structurerTexte("Étude de circulation du centre-ville, en deux phases. Rendu attendu en mars.")).toBeNull();
    expect(estEforms("Lot 1 : études. Nom officiel: x")).toBe(false);
  });
});
