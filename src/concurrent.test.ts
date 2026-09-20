import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "./concurrent.ts";

describe("mapConcurrent", () => {
  test("résultats à la place de leur entrée, au plus n en vol", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapConcurrent(
      [30, 5, 20, 1, 10],
      async (ms) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
        return ms * 2;
      },
      2,
    );
    expect(out).toEqual([60, 10, 40, 2, 20]);
    expect(peak).toBe(2);
  });
  test("liste vide, n nul", async () => {
    expect(await mapConcurrent([], async () => 1, 0)).toEqual([]);
    expect(await mapConcurrent([1], async (x) => x + 1, 0)).toEqual([2]);
  });
  test("une erreur rejette l'ensemble", async () => {
    await expect(mapConcurrent([1, 2], async (x) => { if (x === 2) throw new Error("boom"); return x; }, 2)).rejects.toThrow("boom");
  });
});
