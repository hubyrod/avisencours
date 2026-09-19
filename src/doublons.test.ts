import { describe, expect, test } from "bun:test";
import { acheteurCle, choisirPrincipal, deadlineDay, grouperDoublons, jaccard, motsObjet, objetCle, type Publication } from "./doublons.ts";

const T0 = new Date("2026-09-10T08:00:00Z");
const T1 = new Date("2026-09-12T08:00:00Z");

function pub(p: Partial<Publication> & { idweb: string }): Publication {
  return {
    objet: "Réalisation de prestations d'acquisitions de données (comptages et enquêtes) et réalisation de prestations d'études de circulation et de stationnement",
    acheteur: "Grand Annecy",
    department: "74",
    deadlineDay: "14/10/2026",
    source: "boamp",
    firstSeenAt: T0,
    doublonDe: null,
    activite: 0,
    ...p,
  };
}

describe("clés de rapprochement", () => {
  test("acheteur : casse, accents, parenthèses et mots outils", () => {
    expect(acheteurCle("GRAND ANNECY")).toBe("grand annecy");
    expect(acheteurCle("Grand Annecy (74000 - ANNECY)")).toBe("grand annecy");
    expect(acheteurCle("CA du Grand Annecy")).toBe("grand annecy");
    expect(acheteurCle("Ville d'Alès")).toBe("ales");
    expect(acheteurCle("Communauté de communes du Val")).toBe("communes val");
    expect(acheteurCle(null)).toBe("");
  });
  test("objet : ponctuation et casse ignorées", () => {
    expect(objetCle("Étude de circulation.")).toBe(objetCle("ETUDE DE CIRCULATION"));
    expect(motsObjet("Plan de mobilité simplifié de la CC")).toEqual(new Set(["plan", "mobilite", "simplifie"]));
  });
  test("jaccard", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["a", "b", "c"]))).toBe(1);
    expect(jaccard(new Set(["a", "b", "c", "d"]), new Set(["a", "b", "c"]))).toBe(0.75);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
  test("date limite au jour", () => {
    expect(deadlineDay("14/10/2026 à 10h00")).toBe("14/10/2026");
    expect(deadlineDay("14/10/2026")).toBe("14/10/2026");
    expect(deadlineDay(new Date("2026-10-14T08:00:00Z"))).toBe("14/10/2026");
    expect(deadlineDay(new Date("2026-10-13T23:30:00Z"))).toBe("14/10/2026"); // 01h30 à Paris
    expect(deadlineDay(null)).toBeNull();
    expect(deadlineDay("bientôt")).toBeNull();
  });
});

describe("grouperDoublons", () => {
  test("le cas Grand Annecy : BOAMP et Marchés Online, point final et casse", () => {
    const g = grouperDoublons([
      pub({ idweb: "26-1", source: "boamp", acheteur: "GRAND ANNECY", firstSeenAt: T0 }),
      pub({ idweb: "MO-1", source: "marchesonline", objet: pub({ idweb: "x" }).objet + ".", firstSeenAt: T1 }),
    ]);
    expect(g).toEqual([{ principal: "26-1", doublons: ["MO-1"] }]);
  });
  test("intitulé réécrit : ≥ 85 % de mots communs suffit, en dessous non", () => {
    const base = "Élaboration du plan de mobilité simplifié de la communauté de communes du Val de Drôme";
    const proche = "Élaboration du plan de mobilité simplifié de la communauté de communes du Val de Drôme (relance)";
    const autre = "Élaboration du schéma directeur cyclable de la communauté de communes du Val de Drôme";
    expect(grouperDoublons([pub({ idweb: "a", objet: base }), pub({ idweb: "b", objet: proche, source: "achatpublic" })])).toHaveLength(1);
    expect(grouperDoublons([pub({ idweb: "a", objet: base }), pub({ idweb: "c", objet: autre, source: "achatpublic" })])).toHaveLength(0);
  });
  test("jamais sans date limite, jamais entre départements différents, jamais entre acheteurs différents", () => {
    expect(grouperDoublons([pub({ idweb: "a", deadlineDay: null }), pub({ idweb: "b", deadlineDay: null })])).toHaveLength(0);
    expect(grouperDoublons([pub({ idweb: "a", department: "74" }), pub({ idweb: "b", department: "73" })])).toHaveLength(0);
    expect(grouperDoublons([pub({ idweb: "a", department: "74" }), pub({ idweb: "b", department: "" })])).toHaveLength(1);
    expect(grouperDoublons([pub({ idweb: "a", acheteur: "Grand Annecy" }), pub({ idweb: "b", acheteur: "Grand Chambéry" })])).toHaveLength(0);
    expect(grouperDoublons([pub({ idweb: "a", deadlineDay: "14/10/2026" }), pub({ idweb: "b", deadlineDay: "15/10/2026" })])).toHaveLength(0);
  });
  test("deux lots distincts d'un même acheteur ne sont pas rapprochés", () => {
    const g = grouperDoublons([
      pub({ idweb: "a", objet: "Lot 1 : études de circulation du centre-ville" }),
      pub({ idweb: "b", objet: "Lot 2 : comptages routiers et enquêtes cordon" }),
    ]);
    expect(g).toHaveLength(0);
  });
  test("groupe de trois, transitif", () => {
    const g = grouperDoublons([
      pub({ idweb: "a", firstSeenAt: T1, source: "marchesonline" }),
      pub({ idweb: "b", firstSeenAt: T0, source: "achatpublic" }),
      pub({ idweb: "c", firstSeenAt: T1, source: "boamp", objet: pub({ idweb: "x" }).objet + " (relance)" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.principal).toBe("b");
    expect(g[0]!.doublons.sort()).toEqual(["a", "c"]);
  });
});

describe("choisirPrincipal (stabilité)", () => {
  test("un principal déjà désigné le reste, même plus récent et moins officiel", () => {
    const p = choisirPrincipal([
      pub({ idweb: "MO-1", source: "marchesonline", firstSeenAt: T1 }),
      pub({ idweb: "26-1", source: "boamp", firstSeenAt: T0, doublonDe: "MO-1" }),
    ]);
    expect(p.idweb).toBe("MO-1");
  });
  test("sinon celui qui porte des statuts ou commentaires", () => {
    expect(choisirPrincipal([pub({ idweb: "a", firstSeenAt: T0 }), pub({ idweb: "b", firstSeenAt: T1, activite: 2 })]).idweb).toBe("b");
  });
  test("sinon le plus ancien, sinon la source la plus officielle, sinon l'idweb", () => {
    expect(choisirPrincipal([pub({ idweb: "a", firstSeenAt: T1, source: "boamp" }), pub({ idweb: "b", firstSeenAt: T0, source: "marchesonline" })]).idweb).toBe("b");
    expect(choisirPrincipal([pub({ idweb: "a", source: "marchesonline" }), pub({ idweb: "b", source: "boamp" })]).idweb).toBe("b");
    expect(choisirPrincipal([pub({ idweb: "b", source: "afd" }), pub({ idweb: "a", source: "afd" })]).idweb).toBe("a");
  });
  test("un principal désigné hors du groupe (disparu) ne compte pas", () => {
    expect(choisirPrincipal([pub({ idweb: "a", doublonDe: "parti", firstSeenAt: T1 }), pub({ idweb: "b", firstSeenAt: T0 })]).idweb).toBe("b");
  });
});
