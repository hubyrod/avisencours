import { describe, expect, test } from "bun:test";
import { parseDeadlineText } from "./db.ts";

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
