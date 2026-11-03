import { describe, expect, test } from "bun:test";
import { incidentFromWarning, phrasesEchec, phrasesIncident, titreIncident } from "./incidents.ts";

const MO = "Marchés Online (Le Moniteur) indisponible — Error: 403 Forbidden sur https://… — ses avis ne sont pas mis à jour ce run";
const CSL = "achatpublic.com indisponible — Error: parseCards : page vide — ses avis ne sont pas mis à jour ce run";
const LLM = "coupe-circuit LLM ouvert : 5 échecs consécutifs — les avis restants ont été classés par regex";
const infos = (since: Date | null, conserves: number | null) => () => ({ since, conserves });

describe("incidentFromWarning", () => {
  test("rien sans avertissement ni cause reconnue", () => {
    expect(incidentFromWarning(null, infos(null, null))).toBeNull();
    expect(incidentFromWarning("texte inconnu", infos(null, null))).toBeNull();
  });
  test("sources en panne avec leurs libellés, et le problème LLM", () => {
    const i = incidentFromWarning(`${MO} ; ${CSL} ; ${LLM}`, infos(new Date("2026-10-10T04:30:00Z"), 3))!;
    expect(i.pannes.map((p) => p.label)).toEqual(["achatpublic.com", "Marchés Online (Le Moniteur)"]);
    expect(i.llm).toBe(true);
  });
});

describe("titre et phrases", () => {
  test("une source, depuis une date, avec des avis conservés", () => {
    const i = incidentFromWarning(MO, infos(new Date("2026-10-10T04:30:00Z"), 3))!;
    expect(titreIncident(i)).toBe("Mise à jour partielle : Marchés Online (Le Moniteur) ne répond pas");
    const p = phrasesIncident(i);
    expect(p[0]).toContain("ne répond pas depuis le 10 octobre 2026");
    expect(p[0]).toContain("(3 avis pertinents concernés)");
    expect(p[0]).toContain("ne sont pas détectés tant que cela dure");
    expect(p[p.length - 1]).toBe("L'équipe technique est prévenue.");
    expect(p.length).toBe(2);
  });
  test("deux sources, date inconnue, aucun avis conservé", () => {
    const i = incidentFromWarning(`${MO} ; ${CSL}`, infos(null, 0))!;
    expect(titreIncident(i)).toBe("Mise à jour partielle : achatpublic.com et Marchés Online (Le Moniteur) ne répondent pas");
    const p = phrasesIncident(i);
    expect(p[0]).toContain("n'a pas répondu lors de cette mise à jour");
    expect(p[0]).not.toContain("concerné");
    expect(p.length).toBe(3);
  });
  test("LLM seul", () => {
    const i = incidentFromWarning(LLM, infos(null, null))!;
    expect(titreIncident(i)).toBe("Classification automatique interrompue");
    expect(phrasesIncident(i)[0]).toContain("règles simples");
  });
  test("échec de la mise à jour", () => {
    const p = phrasesEchec("mardi 3 novembre 2026", new Date("2026-11-02T04:32:00Z"), "à midi, puis demain matin");
    expect(p[0]).toBe("La mise à jour des avis du mardi 3 novembre 2026 n'a pas pu être effectuée.");
    expect(p[1]).toContain("2 novembre 2026");
    expect(p[2]).toBe("Une nouvelle tentative aura lieu automatiquement à midi, puis demain matin.");
    expect(phrasesEchec("x", null, "demain matin")[1]).toContain("Aucune mise à jour réussie");
  });
});
