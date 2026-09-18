import { describe, expect, test } from "bun:test";
import { normalizeLlmStats, parseDeadlineText } from "./db.ts";

describe("parseDeadlineText", () => {
  test("date et heure au format du scraper", () => {
    const d = parseDeadlineText("16/07/2026 à 14h30");
    expect(d?.toISOString()).toBe("2026-07-16T14:30:00.000Z");
  });

  test("date seule", () => {
    const d = parseDeadlineText("01/12/2026");
    expect(d?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  test("entrées invalides", () => {
    expect(parseDeadlineText(null)).toBeNull();
    expect(parseDeadlineText("")).toBeNull();
    expect(parseDeadlineText("bientôt")).toBeNull();
  });
});

describe("normalizeLlmStats", () => {
  const stats = { calls: 3, errors: 0, retries: 0, fallbacks: 0, promptTokens: 10, completionTokens: 2, costUsd: 0.001, byModel: { "mistralai/mistral-nemo": 3 }, breakerTripped: false };
  test("objet tel quel", () => {
    expect(normalizeLlmStats(stats)).toEqual(stats);
  });
  test("chaîne JSON (jsonb doublement sérialisé)", () => {
    expect(normalizeLlmStats(JSON.stringify(stats))).toEqual(stats);
  });
  test("byModel manquant, valeurs invalides", () => {
    expect(normalizeLlmStats({ ...stats, byModel: undefined })?.byModel).toEqual({});
    expect(normalizeLlmStats("pas du json")).toBeNull();
    expect(normalizeLlmStats(null)).toBeNull();
    expect(normalizeLlmStats({ foo: 1 })).toBeNull();
  });
});
