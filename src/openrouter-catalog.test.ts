import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cheapestJson,
  creditLabel,
  fetchCatalog,
  fetchKeyCredit,
  parseCatalog,
  priceLabel,
  resetCatalogCache,
  suggestions,
  usable,
} from "./openrouter-catalog.ts";

const raw = {
  data: [
    {
      id: "mistralai/mistral-nemo",
      name: "Mistral Nemo",
      context_length: 131072,
      pricing: { prompt: "0.000000019", completion: "0.00000003" },
      supported_parameters: ["temperature", "response_format"],
      architecture: { input_modalities: ["text"] },
    },
    {
      id: "cheap/no-json",
      name: "No JSON",
      pricing: { prompt: "0.00000001", completion: "0.00000001" },
      supported_parameters: ["temperature"],
    },
    {
      id: "free/model:free",
      name: "Free",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["response_format"],
    },
    {
      id: "openrouter/auto",
      name: "Auto",
      pricing: { prompt: "-1", completion: "-1" },
      supported_parameters: ["response_format"],
    },
    {
      id: "vision/only",
      name: "Vision",
      pricing: { prompt: "0.00000001", completion: "0.00000001" },
      supported_parameters: ["response_format"],
      architecture: { input_modalities: ["image"] },
    },
    {
      id: "google/gemini-2.5-flash-lite",
      name: "Gemini Flash Lite",
      context_length: 1048576,
      pricing: { prompt: "0.00000005", completion: "0.0000002" },
      supported_parameters: ["response_format", "structured_outputs"],
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "same/prompt-price",
      name: "Tie",
      pricing: { prompt: "0.00000005", completion: "0.0000001" },
      supported_parameters: ["response_format"],
    },
    { id: 42 },
  ],
};

describe("parseCatalog", () => {
  test("convertit en $/M, détecte JSON et texte", () => {
    const models = parseCatalog(raw);
    expect(models).toHaveLength(7);
    const nemo = models.find((m) => m.id === "mistralai/mistral-nemo")!;
    expect(nemo.promptPerM).toBeCloseTo(0.019);
    expect(nemo.completionPerM).toBeCloseTo(0.03);
    expect(nemo.contextLength).toBe(131072);
    expect(nemo.json).toBe(true);
    expect(nemo.textIn).toBe(true);
    expect(models.find((m) => m.id === "cheap/no-json")!.json).toBe(false);
    expect(models.find((m) => m.id === "vision/only")!.textIn).toBe(false);
  });
  test("réponse inattendue -> liste vide", () => {
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: "x" })).toEqual([]);
  });
});

describe("usable / cheapestJson / suggestions", () => {
  const models = parseCatalog(raw);
  test("filtre : JSON, texte, payant, pas de pseudo-modèle", () => {
    expect(models.filter(usable).map((m) => m.id)).toEqual([
      "mistralai/mistral-nemo",
      "google/gemini-2.5-flash-lite",
      "same/prompt-price",
    ]);
  });
  test("tri par prix d'entrée puis de sortie", () => {
    expect(cheapestJson(models, 10).map((m) => m.id)).toEqual([
      "mistralai/mistral-nemo",
      "same/prompt-price",
      "google/gemini-2.5-flash-lite",
    ]);
    expect(cheapestJson(models, 1).map((m) => m.id)).toEqual(["mistralai/mistral-nemo"]);
  });
  test("recommandés d'abord, puis les moins chers sans doublon", () => {
    const s = suggestions(models, ["google/gemini-2.5-flash-lite", "absent/model"], 10);
    expect(s.map((m) => m.id)).toEqual([
      "google/gemini-2.5-flash-lite",
      "mistralai/mistral-nemo",
      "same/prompt-price",
    ]);
  });
  test("priceLabel", () => {
    expect(priceLabel(models[0]!)).toBe("0,019 $ / 0,03 $ par M tokens");
  });
});

describe("fetchCatalog / fetchKeyCredit", () => {
  const saved = { key: Bun.env.OPENROUTER_API_KEY, base: Bun.env.OPENROUTER_BASE_URL };
  beforeAll(() => {
    Bun.env.OPENROUTER_API_KEY = "k";
    Bun.env.OPENROUTER_BASE_URL = "http://openrouter.test/api/v1";
    resetCatalogCache();
  });
  afterAll(() => {
    if (saved.key === undefined) delete Bun.env.OPENROUTER_API_KEY;
    else Bun.env.OPENROUTER_API_KEY = saved.key;
    if (saved.base === undefined) delete Bun.env.OPENROUTER_BASE_URL;
    else Bun.env.OPENROUTER_BASE_URL = saved.base;
    resetCatalogCache();
  });

  test("cache d'une heure, null si injoignable", async () => {
    let n = 0;
    let now = 1_000_000;
    const fetchImpl = (async () => {
      n++;
      return Response.json(raw);
    });
    const a = await fetchCatalog({ fetchImpl, now: () => now });
    expect(a).toHaveLength(7);
    await fetchCatalog({ fetchImpl, now: () => now + 30 * 60_000 });
    expect(n).toBe(1);
    now += 61 * 60_000;
    await fetchCatalog({ fetchImpl, now: () => now });
    expect(n).toBe(2);

    resetCatalogCache();
    const failing = (async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchCatalog({ fetchImpl: failing })).toBeNull();
    const notOk = (async () => new Response("nope", { status: 500 }));
    expect(await fetchCatalog({ fetchImpl: notOk })).toBeNull();
  });

  test("crédit : reste calculé depuis limit_remaining ou limit - usage", async () => {
    const mk = (data: Record<string, unknown>) => (async () => Response.json({ data }));
    expect(await fetchKeyCredit({ fetchImpl: mk({ usage: 1.5, limit: 10, limit_remaining: 8.5 }) })).toEqual({
      usage: 1.5,
      limit: 10,
      remaining: 8.5,
    });
    expect(await fetchKeyCredit({ fetchImpl: mk({ usage: 2, limit: 10 }) })).toEqual({ usage: 2, limit: 10, remaining: 8 });
    expect(await fetchKeyCredit({ fetchImpl: mk({ usage: 2, limit: null }) })).toEqual({ usage: 2, limit: null, remaining: null });
    expect(creditLabel({ usage: 2, limit: 10, remaining: 8 })).toBe("2,00 $ consommés, reste 8,00 $");
    expect(creditLabel({ usage: 2, limit: null, remaining: null })).toBe("2,00 $ consommés");
  });
});
