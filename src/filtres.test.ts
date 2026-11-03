import { describe, expect, test } from "bun:test";
import { chercheDans, compterFacettes, filtrerAvis, motsRecherche, trierAvis } from "./filtres.ts";
import type { StoredAnnouncement } from "./db.ts";

const avis = (idweb: string, extra: Partial<StoredAnnouncement> = {}): StoredAnnouncement => ({
  idweb,
  url: `https://x/${idweb}`,
  objet: `Objet ${idweb}`,
  acheteur: "Ville",
  department: "75",
  type_avis: null,
  procedure: null,
  published_at: null,
  deadline: new Date("2030-12-31T12:00:00Z"),
  deadline_text: "31/12/2030 à 12h00",
  category: "relevant",
  reason: null,
  source: "boamp",
  famille: "mobilité",
  first_seen_run_id: 1,
  first_seen_at: new Date("2026-10-01T06:00:00Z"),
  status_id: 1,
  status_is_rejet: false,
  ...extra,
});

describe("recherche", () => {
  test("mots pliés (accents, casse), tous requis, dans n'importe quel ordre", () => {
    expect(motsRecherche("  Vélo  Lyon ")).toEqual(["velo", "lyon"]);
    const a = avis("A", { objet: "SCHEMA DIRECTEUR VELO", acheteur: "Métropole de Lyon" });
    for (const q of ["vélo", "VÉLO", "velo", "lyon vélo", "métropole", "schema velo"]) {
      expect(chercheDans(a, motsRecherche(q))).toBe(true);
    }
    expect(chercheDans(a, motsRecherche("vélo Paris"))).toBe(false);
    expect(chercheDans(a, motsRecherche(""))).toBe(true);
  });
  test("cherche aussi le département et l'objet / acheteur des doublons", () => {
    const a = avis("A", {
      department: "69",
      publications: [
        { idweb: "A", source: "boamp", url: "u", published_at: null, objet: "Objet A", acheteur: "Ville" },
        { idweb: "MO-A", source: "marchesonline", url: "v", published_at: null, objet: "Étude de stationnement.", acheteur: "GRAND ANNECY" },
      ],
    });
    expect(chercheDans(a, motsRecherche("69"))).toBe(true);
    expect(chercheDans(a, motsRecherche("stationnement."))).toBe(true);
    expect(chercheDans(a, motsRecherche("annecy"))).toBe(true);
    expect(chercheDans(a, motsRecherche("%"))).toBe(false);
  });
});

describe("filtrerAvis", () => {
  const items = [
    avis("A"),
    avis("B", { status_id: 2, status_set_at: new Date("2026-10-02T00:00:00Z") }),
    avis("C", { status_id: 3, status_is_rejet: true, status_set_at: new Date("2026-10-02T00:00:00Z"), famille: "inondations", source: "achatpublic" }),
    avis("D", {
      publications: [
        { idweb: "D", source: "boamp", url: "u", published_at: null },
        { idweb: "MO-D", source: "marchesonline", url: "v", published_at: null },
      ],
      first_seen_at: new Date("2026-11-01T06:00:00Z"),
    }),
  ];
  const ids = (xs: StoredAnnouncement[]) => xs.map((a) => a.idweb);
  test("chaque filtre seul, puis combinés", () => {
    expect(ids(filtrerAvis(items, {}))).toEqual(["A", "B", "C", "D"]);
    expect(ids(filtrerAvis(items, { statusId: 1 }))).toEqual(["A", "D"]);
    expect(ids(filtrerAvis(items, { masquerRejet: true }))).toEqual(["A", "B", "D"]);
    expect(ids(filtrerAvis(items, { famille: "inondations" }))).toEqual(["C"]);
    expect(ids(filtrerAvis(items, { source: "marchesonline" }))).toEqual(["D"]);
    expect(ids(filtrerAvis(items, { source: "boamp" }))).toEqual(["A", "B", "D"]);
    expect(ids(filtrerAvis(items, { q: "objet d" }))).toEqual(["D"]);
    expect(ids(filtrerAvis(items, { newSince: new Date("2026-10-15T00:00:00Z") }))).toEqual(["D"]);
    expect(ids(filtrerAvis(items, { statusId: 1, source: "marchesonline", q: "ville" }))).toEqual(["D"]);
    expect(ids(filtrerAvis(items, { statusId: 3, masquerRejet: true }))).toEqual([]);
  });
});

describe("trierAvis", () => {
  const items = [
    avis("sans-ancien", { deadline: new Date("2030-12-31T12:00:00Z"), first_seen_at: new Date("2026-10-01T00:00:00Z") }),
    avis("sans-recent", { deadline: new Date("2031-12-31T12:00:00Z"), first_seen_at: new Date("2026-10-03T00:00:00Z") }),
    avis("statue-tard", { deadline: new Date("2031-06-30T12:00:00Z"), status_set_at: new Date("2026-10-02T00:00:00Z") }),
    avis("statue-tot", { deadline: new Date("2030-06-30T12:00:00Z"), status_set_at: new Date("2026-10-02T00:00:00Z") }),
    avis("sans-echeance", { deadline: null, first_seen_at: new Date("2026-09-01T00:00:00Z"), status_set_at: new Date("2026-10-02T00:00:00Z") }),
  ];
  const ids = (xs: StoredAnnouncement[]) => xs.map((a) => a.idweb);
  test("à trier d'abord (récents en tête), puis par échéance ; sans échéance en dernier", () => {
    expect(ids(trierAvis(items, "atrier"))).toEqual(["sans-recent", "sans-ancien", "statue-tot", "statue-tard", "sans-echeance"]);
    expect(ids(trierAvis(items, "echeance"))).toEqual(["statue-tot", "sans-ancien", "statue-tard", "sans-recent", "sans-echeance"]);
    // Même date de repérage (statue-*) : départage par échéance.
    expect(ids(trierAvis(items, "recents"))).toEqual(["sans-recent", "statue-tot", "statue-tard", "sans-ancien", "sans-echeance"]);
    expect(ids(items)[0]).toBe("sans-ancien"); // l'entrée n'est pas modifiée
  });
});

describe("compterFacettes", () => {
  const items = [
    avis("A"),
    avis("B", { status_id: 2 }),
    avis("C", { status_id: 3, status_is_rejet: true, famille: "inondations", source: "achatpublic" }),
    avis("D", {
      publications: [
        { idweb: "D", source: "boamp", url: "u", published_at: null },
        { idweb: "MO-D", source: "marchesonline", url: "v", published_at: null },
      ],
    }),
  ];
  test("chaque facette compte avec les autres filtres en place, jamais avec le sien", () => {
    const f = compterFacettes(items, {});
    expect([...f.statut]).toEqual([[1, 2], [2, 1], [3, 1]]);
    expect([...f.source]).toEqual([["boamp", 3], ["achatpublic", 1], ["marchesonline", 1]]);
    expect([...f.famille]).toEqual([["mobilité", 3], ["inondations", 1]]);
    expect(f.rejetMasques).toBe(0);

    // Statut choisi : les sources comptent dans ce statut, les statuts restent tous proposés.
    const g = compterFacettes(items, { statusId: 1, masquerRejet: true });
    expect([...g.source]).toEqual([["boamp", 2], ["marchesonline", 1]]);
    expect([...g.statut]).toEqual([[1, 2], [2, 1], [3, 1]]); // le masquage des rejets ne cache pas leur compte
    expect(g.rejetMasques).toBe(0); // C n'est pas au statut 1 : rien de masqué dans cette vue

    const h = compterFacettes(items, { masquerRejet: true });
    expect(h.rejetMasques).toBe(1);
    expect([...h.famille]).toEqual([["mobilité", 3]]);
  });
});
