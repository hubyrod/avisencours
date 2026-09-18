import { describe, expect, test } from "bun:test";
import { SOURCES, SOURCE_LABELS, isSource, isSourceEnabled, sourceLabel } from "./sources.ts";
import { MPE_SITES } from "./mpe.ts";

describe("sources registry", () => {
  test("identifiants et libellés uniques, URL https", () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(SOURCES.map((s) => s.label)).size).toBe(ids.length);
    for (const s of SOURCES) expect(s.url).toMatch(/^https:\/\//);
    expect(SOURCE_LABELS.boamp).toBe("BOAMP");
  });
  test("les sites MPE sont déclarés dans le registre avec la même variable", () => {
    for (const site of MPE_SITES) {
      const info = SOURCES.find((s) => s.id === site.source);
      expect(info?.env).toBe(site.env);
    }
  });
  test("libellé et validation d'identifiant", () => {
    expect(sourceLabel("achatpublic")).toBe("achatpublic.com");
    expect(sourceLabel(null)).toBe("BOAMP");
    expect(sourceLabel("inconnu")).toBe("inconnu");
    expect(isSource("afd")).toBe(true);
    expect(isSource("x")).toBe(false);
    expect(isSource(null)).toBe(false);
  });
  test("activation par variable d'environnement", () => {
    expect(isSourceEnabled("boamp", {})).toBe(true);
    expect(isSourceEnabled("afd", {})).toBe(true);
    expect(isSourceEnabled("afd", { AFD: "0" })).toBe(false);
    expect(isSourceEnabled("afd", { AFD: "1" })).toBe(true);
    expect(isSourceEnabled("boamp", { BOAMP: "0" })).toBe(true);
  });
});
