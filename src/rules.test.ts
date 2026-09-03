import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import {
  applyScopeRules,
  buildQueryFromKeywords,
  validateKeyword,
  validateRuleTerm,
  validateDigestWindow,
  validateClassifierMode,
  validateModelChain,
  parseModelChain,
  parseDepartements,
} from "./rules.ts";
import { buildApiUrl } from "./params.ts";

const avis = (objet: string, raw = "") => ({ objet, raw });

describe("applyScopeRules", () => {
  test("null quand aucune règle ne correspond", () => {
    expect(applyScopeRules(avis("Étude de mobilité"), { keep: [], exclude: [] })).toBeNull();
    expect(
      applyScopeRules(avis("Étude de mobilité"), { keep: ["tramway"], exclude: ["fibre"] }),
    ).toBeNull();
  });

  test("correspondance insensible aux accents et à la casse, sur objet et raw", () => {
    const r = applyScopeRules(avis("SCHÉMA DIRECTEUR CYCLABLE"), {
      keep: ["schema directeur"],
      exclude: [],
    });
    expect(r?.category).toBe("relevant");
    const r2 = applyScopeRules(avis("Étude", "Acheteur: Région — pôle d'échange multimodal"), {
      keep: [],
      exclude: ["POLE D'ECHANGE"],
    });
    expect(r2?.category).toBe("excluded");
  });

  test("« garder » l'emporte quand les deux correspondent", () => {
    const r = applyScopeRules(avis("Plan vélo et voirie"), {
      keep: ["plan vélo"],
      exclude: ["voirie"],
    });
    expect(r?.category).toBe("relevant");
  });

  test("la raison cite le terme et « règle personnalisée »", () => {
    const keep = applyScopeRules(avis("Plan vélo"), { keep: ["plan vélo"], exclude: [] });
    expect(keep?.reason).toContain("règle personnalisée");
    expect(keep?.reason).toContain("plan vélo");
    const excl = applyScopeRules(avis("Réseau fibre"), { keep: [], exclude: ["fibre"] });
    expect(excl?.reason).toContain("règle personnalisée");
    expect(excl?.reason).toContain("fibre");
  });
});

describe("buildQueryFromKeywords", () => {
  test("mot simple non cité, expression multi-mots citée", () => {
    expect(buildQueryFromKeywords(["vélo", "pôle d'échange"])).toBe('vélo OR "pôle d\'échange"');
  });

  const saved = { url: Bun.env.PORTAL_API_URL, dataset: Bun.env.PORTAL_DATASET };
  beforeAll(() => {
    Bun.env.PORTAL_API_URL = "https://portal.example/api";
    Bun.env.PORTAL_DATASET = "boamp";
  });
  afterAll(() => {
    Bun.env.PORTAL_API_URL = saved.url;
    Bun.env.PORTAL_DATASET = saved.dataset;
  });

  test("aller-retour à travers buildApiUrl", () => {
    const url = buildApiUrl({ query: buildQueryFromKeywords(["vélo", "pôle d'échange"]) });
    const where = decodeURIComponent(url.split("where=")[1]!);
    expect(where).toContain('search(*, "vélo")');
    expect(where).toContain('search(*, "pôle d\'échange")');
  });
});

describe("validateKeyword", () => {
  test("trim + suppression des guillemets", () => {
    const r = validateKeyword('  "schéma directeur"  ');
    expect(r).toEqual({ ok: true, value: "schéma directeur" });
  });

  test("rejette vide, trop court, trop long", () => {
    expect(validateKeyword("").ok).toBe(false);
    expect(validateKeyword(" v ").ok).toBe(false);
    expect(validateKeyword("x".repeat(81)).ok).toBe(false);
    expect(validateKeyword("x".repeat(80)).ok).toBe(true);
  });

  test("rejette le mot OR (séparateur de requête)", () => {
    expect(validateKeyword("vélo OR piéton").ok).toBe(false);
    expect(validateKeyword("OR vélo").ok).toBe(false);
    expect(validateKeyword("vélo OR").ok).toBe(false);
    // ...mais pas un mot qui contient « or »
    expect(validateKeyword("corridor").ok).toBe(true);
    expect(validateKeyword("transport").ok).toBe(true);
  });
});

describe("validateRuleTerm", () => {
  test("bornes de longueur", () => {
    expect(validateRuleTerm(" a ").ok).toBe(false);
    expect(validateRuleTerm("ab").ok).toBe(true);
    expect(validateRuleTerm("x".repeat(121)).ok).toBe(false);
  });
});

describe("validateDigestWindow", () => {
  test("entier entre 1 et 60", () => {
    expect(validateDigestWindow("14")).toEqual({ ok: true, value: "14" });
    expect(validateDigestWindow("1").ok).toBe(true);
    expect(validateDigestWindow("60").ok).toBe(true);
    expect(validateDigestWindow("0").ok).toBe(false);
    expect(validateDigestWindow("61").ok).toBe(false);
    expect(validateDigestWindow("7,5").ok).toBe(false);
    expect(validateDigestWindow("abc").ok).toBe(false);
  });
});

describe("validateClassifierMode", () => {
  test("regex | llm | hybrid uniquement", () => {
    expect(validateClassifierMode("hybrid").ok).toBe(true);
    expect(validateClassifierMode("regex").ok).toBe(true);
    expect(validateClassifierMode("llm").ok).toBe(true);
    expect(validateClassifierMode("autre").ok).toBe(false);
  });
});

describe("validateModelChain", () => {
  test("normalise espaces, casse et sauts de ligne", () => {
    const v = validateModelChain(" Mistralai/Mistral-Nemo ,google/gemini-2.5-flash-lite\n");
    expect(v).toEqual({ ok: true, value: "mistralai/mistral-nemo,google/gemini-2.5-flash-lite" });
    expect(parseModelChain(v.ok ? v.value : "")).toEqual(["mistralai/mistral-nemo", "google/gemini-2.5-flash-lite"]);
  });
  test("suffixes :floor / :nitro acceptés, :free / :online / :thinking refusés", () => {
    expect(validateModelChain("mistralai/mistral-nemo:floor").ok).toBe(true);
    expect(validateModelChain("mistralai/mistral-nemo:nitro").ok).toBe(true);
    expect(validateModelChain("mistralai/mistral-nemo:free").ok).toBe(false);
    expect(validateModelChain("x/y:online").ok).toBe(false);
    expect(validateModelChain("x/y:thinking").ok).toBe(false);
  });
  test("slug invalide, vide, doublon, trop long", () => {
    expect(validateModelChain("mistral-small-latest").ok).toBe(false);
    expect(validateModelChain("a/b/c").ok).toBe(false);
    expect(validateModelChain("").ok).toBe(false);
    expect(validateModelChain(" , ").ok).toBe(false);
    expect(validateModelChain("a/b,a/b").ok).toBe(false);
    expect(validateModelChain("a/b,c/d,e/f,g/h,i/j").ok).toBe(true);
    expect(validateModelChain("a/b,c/d,e/f,g/h,i/j,k/l").ok).toBe(false);
  });
  test("parseModelChain tolère null", () => {
    expect(parseModelChain(null)).toEqual([]);
    expect(parseModelChain(undefined)).toEqual([]);
  });
});

describe("parseDepartements", () => {
  test("liste avec espaces, corse, DOM", () => {
    expect(parseDepartements("31, 2a, 974")).toEqual({ ok: true, codes: ["31", "2A", "974"] });
  });
  test("vide = aucune restriction", () => {
    expect(parseDepartements("")).toEqual({ ok: true, codes: [] });
  });
  test("rejette un code invalide", () => {
    expect(parseDepartements("31, abc").ok).toBe(false);
    expect(parseDepartements("3").ok).toBe(false);
  });
});
