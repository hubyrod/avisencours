import { describe, expect, test } from "bun:test";
import { decouperRaw } from "./avis-texte.ts";

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
