import { describe, expect, test } from "bun:test";
import {
  ProgressTracker,
  formatCounter,
  formatDuration,
  normalizeProgress,
  progressPercent,
  summarizeProgress,
  type RunProgress,
} from "./progress.ts";

const DEFS = [
  { id: "boamp", label: "BOAMP", unit: "pages" as const },
  { id: "achatpublic", label: "achatpublic.com", unit: "pages" as const },
  { id: "classify", label: "Classement", unit: "avis" as const },
];

function clock(start = 0) {
  let t = start;
  return { now: () => new Date(t), tick: (ms: number) => (t += ms) };
}

describe("ProgressTracker", () => {
  test("transitions et instantané", () => {
    const c = clock(1_000_000);
    const seen: RunProgress[] = [];
    const tr = new ProgressTracker(DEFS, { onChange: (p) => seen.push(p), now: c.now });
    expect(tr.snapshot().steps.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);

    tr.start("boamp", 38);
    tr.advance("boamp", 12);
    tr.finish("boamp", "3 804 avis");
    tr.skip("achatpublic", "désactivée");
    tr.advance("classify", 5, 3900); // démarre implicitement
    const s = tr.snapshot();
    expect(s.steps[0]).toMatchObject({ status: "done", done: 12, total: 38, detail: "3 804 avis" });
    expect(s.steps[0]!.startedAt).toBeDefined();
    expect(s.steps[0]!.finishedAt).toBeDefined();
    expect(s.steps[1]).toMatchObject({ status: "skipped", detail: "désactivée" });
    expect(s.steps[2]).toMatchObject({ status: "running", done: 5, total: 3900 });
    expect(s.updatedAt).toBe(new Date(1_000_000).toISOString());
    expect(seen.length).toBeGreaterThan(0);
  });

  test("échec et total inconnu rempli à la fin", () => {
    const tr = new ProgressTracker(DEFS);
    tr.start("boamp");
    tr.advance("boamp", 7);
    tr.finish("boamp");
    tr.fail("achatpublic", "indisponible : 503");
    const s = tr.snapshot();
    expect(s.steps[0]).toMatchObject({ status: "done", done: 7, total: 7 });
    expect(s.steps[1]).toMatchObject({ status: "failed", detail: "indisponible : 503" });
    expect(() => tr.start("inconnue")).toThrow();
  });

  test("les compteurs sont limités dans le temps, les changements d'état jamais", () => {
    const c = clock();
    let n = 0;
    const tr = new ProgressTracker(DEFS, { onChange: () => n++, throttleMs: 2000, now: c.now });
    tr.start("classify", 100); // 1 (forcé)
    for (let i = 1; i <= 50; i++) {
      c.tick(100);
      tr.advance("classify", i); // toutes les 2 s : à 2,0 s / 4,0 s
    }
    expect(n).toBe(1 + 2);
    tr.finish("classify"); // forcé
    expect(n).toBe(4);
  });
});

describe("progressPercent", () => {
  const p = (steps: RunProgress["steps"]): RunProgress => ({ steps, updatedAt: "" });
  test("étapes terminées et fraction de l'étape en cours", () => {
    expect(progressPercent(p([]))).toBe(0);
    expect(progressPercent(p([{ id: "a", label: "a", status: "done" }, { id: "b", label: "b", status: "pending" }]))).toBe(0.5);
    expect(
      progressPercent(
        p([
          { id: "a", label: "a", status: "done" },
          { id: "b", label: "b", status: "running", done: 25, total: 100 },
          { id: "c", label: "c", status: "skipped" },
          { id: "d", label: "d", status: "pending" },
        ]),
      ),
    ).toBeCloseTo((1 + 0.25) / 3);
    expect(progressPercent(p([{ id: "a", label: "a", status: "failed" }]))).toBe(1);
  });
});

describe("formats et résumé", () => {
  test("compteur et durée", () => {
    expect(formatCounter({ id: "x", label: "x", status: "running", done: 1240, total: 3900, unit: "avis" })).toBe("1 240 / 3 900 avis");
    expect(formatCounter({ id: "x", label: "x", status: "running", done: 3, unit: "pages" })).toBe("3 pages");
    expect(formatCounter({ id: "x", label: "x", status: "pending" })).toBe("");
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 05");
  });
  test("résumé pour le bandeau", () => {
    const progress: RunProgress = {
      updatedAt: "",
      steps: [
        { id: "boamp", label: "BOAMP", status: "done" },
        { id: "achatpublic", label: "achatpublic.com", status: "done" },
        { id: "afd", label: "AFD", status: "failed", detail: "503" },
        { id: "maximilien", label: "Maximilien", status: "running", done: 8, total: 22, unit: "pages" },
        { id: "classify", label: "Classement", status: "pending" },
      ],
    };
    const start = new Date("2026-09-18T10:00:00Z");
    const now = new Date("2026-09-18T10:12:00Z");
    expect(summarizeProgress(progress, start, now)).toBe(
      "BOAMP, achatpublic.com terminés · AFD en échec · Maximilien 8 / 22 pages · démarrée il y a 12 min",
    );
    expect(summarizeProgress({ steps: [], updatedAt: "" }, start, now)).toBe("démarrée il y a 12 min");
  });
  test("normalisation d'une valeur lue en base", () => {
    const p: RunProgress = { steps: [{ id: "a", label: "A", status: "done" }], updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(normalizeProgress(p)).toEqual(p);
    expect(normalizeProgress(JSON.stringify(p))).toEqual(p);
    expect(normalizeProgress({ steps: [{ id: "a", status: "done" }, null, "x", { label: "sans id" }] })?.steps).toHaveLength(1);
    expect(normalizeProgress(null)).toBeNull();
    expect(normalizeProgress("nope")).toBeNull();
    expect(normalizeProgress({ foo: 1 })).toBeNull();
  });
});
