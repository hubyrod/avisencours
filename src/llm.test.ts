import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  Breaker,
  LlmAuthError,
  LlmContentError,
  chatJSON,
  formatUsd,
  llmStatsSummary,
  newLlmStats,
  parseJsonObject,
  recordCall,
  type ChatDeps,
  type Msg,
} from "./llm.ts";
import { HttpError, postWithRetry } from "./http.ts";
import { classifyLLM, parseClassification, type LlmContext } from "./classify-llm.ts";
import type { Announcement } from "./scraper.ts";

// --- fake fetch -----------------------------------------------------------------

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Reply = Response | Error | ((call: Call) => Response | Error);

function completion(content: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({
    model: "a/one",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 },
    ...extra,
  });
}

function status(code: number, body = "err"): Response {
  return new Response(body, { status: code });
}

function timeoutError(): Error {
  const e = new Error("The operation timed out.");
  e.name = "TimeoutError";
  return e;
}

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const deps: ChatDeps = {
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const call: Call = {
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected fetch #${calls.length}`);
      const r = typeof next === "function" ? next(call) : next;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { deps, calls };
}

const messages: Msg[] = [{ role: "user", content: "hi" }];
const CHAIN = ["a/one", "b/two", "c/three"];
const parse = (s: string) => parseJsonObject(s) as { x: number };

const env = { key: Bun.env.OPENROUTER_API_KEY, base: Bun.env.OPENROUTER_BASE_URL, max: Bun.env.LLM_MAX_PRICE_PER_M };
beforeAll(() => {
  Bun.env.OPENROUTER_API_KEY = "test-key";
  Bun.env.OPENROUTER_BASE_URL = "http://openrouter.test/api/v1/";
  Bun.env.LLM_MAX_PRICE_PER_M = "2";
});
afterAll(() => {
  for (const [k, v] of [
    ["OPENROUTER_API_KEY", env.key],
    ["OPENROUTER_BASE_URL", env.base],
    ["LLM_MAX_PRICE_PER_M", env.max],
  ] as const) {
    if (v === undefined) delete Bun.env[k];
    else Bun.env[k] = v;
  }
});

// --- parseJsonObject --------------------------------------------------------------

describe("parseJsonObject", () => {
  test("JSON nu, clôturé, ou noyé dans une phrase", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Voici : {"a":{"b":2}} voilà.')).toEqual({ a: { b: 2 } });
  });
  test("rien d'exploitable -> LlmContentError", () => {
    expect(() => parseJsonObject("pas de json")).toThrow(LlmContentError);
    expect(() => parseJsonObject("{oops")).toThrow(LlmContentError);
  });
});

describe("parseClassification", () => {
  test("catégorie valide + raison tronquée", () => {
    expect(parseClassification('{"category":"travaux","reason":"MOE"}')).toEqual({ category: "travaux", reason: "MOE" });
    expect(parseClassification('{"category":"relevant"}')).toEqual({ category: "relevant", reason: undefined });
  });
  test("catégorie inconnue -> LlmContentError", () => {
    expect(() => parseClassification('{"category":"maybe"}')).toThrow(LlmContentError);
  });
});

// --- chatJSON ---------------------------------------------------------------------

describe("chatJSON", () => {
  test("requête OpenRouter : chaîne, tri par prix, JSON, usage ; réponse parsée", async () => {
    const { deps, calls } = fakeFetch([completion('{"x":1}')]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.value).toEqual({ x: 1 });
    expect(r.model).toBe("a/one");
    expect(r.promptTokens).toBe(100);
    expect(r.completionTokens).toBe(10);
    expect(r.costUsd).toBeCloseTo(0.0001);
    expect(r.retries).toBe(0);
    expect(r.rotated).toBe(false);

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("http://openrouter.test/api/v1/chat/completions");
    expect(c.headers.Authorization).toBe("Bearer test-key");
    expect(c.headers["X-Title"]).toBe("avis-en-cours");
    expect(c.body.model).toBe("a/one");
    expect(c.body.models).toEqual(CHAIN);
    expect(c.body.temperature).toBe(0);
    expect(c.body.response_format).toEqual({ type: "json_object" });
    expect(c.body.provider).toEqual({
      sort: "price",
      require_parameters: true,
      max_price: { prompt: 2, completion: 2 },
    });
    expect(c.body.usage).toEqual({ include: true });
  });

  test("modèle unique : pas de champ models", async () => {
    const { deps, calls } = fakeFetch([completion('{"x":1}')]);
    await chatJSON({ messages, models: ["a/one"], parse }, deps);
    expect(calls[0]!.body.models).toBeUndefined();
  });

  test("429 puis 200 -> un réessai compté", async () => {
    const { deps, calls } = fakeFetch([status(429), completion('{"x":1}')]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(calls).toHaveLength(2);
    expect(r.retries).toBe(1);
  });

  test("délai dépassé puis 200 -> réessayé", async () => {
    const { deps, calls } = fakeFetch([timeoutError(), completion('{"x":1}')]);
    const r = await chatJSON({ messages, models: ["a/one"], parse }, deps);
    expect(calls).toHaveLength(2);
    expect(r.retries).toBe(1);
  });

  test("flux de réponse coupé (délai pendant la lecture du corps) -> réessayé", async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.error(timeoutError());
        },
      }),
      { status: 200 },
    );
    const { deps, calls } = fakeFetch([broken, completion('{"x":1}')]);
    const r = await chatJSON({ messages, models: ["a/one"], parse }, deps);
    expect(calls).toHaveLength(2);
    expect(r.retries).toBe(1);
  });

  test("corps 200 non JSON -> contenu inexploitable (rotation)", async () => {
    const { deps, calls } = fakeFetch([new Response("<html>gateway</html>", { status: 200 }), completion('{"x":1}', { model: "b/two" })]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.rotated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("401 -> LlmAuthError sans réessai", async () => {
    const { deps, calls } = fakeFetch([status(401, "bad key")]);
    await expect(chatJSON({ messages, models: CHAIN, parse }, deps)).rejects.toBeInstanceOf(LlmAuthError);
    expect(calls).toHaveLength(1);
  });

  test("402 -> LlmAuthError avec statut", async () => {
    const { deps } = fakeFetch([status(402, "no credits")]);
    const err = await chatJSON({ messages, models: CHAIN, parse }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(LlmAuthError);
    expect((err as LlmAuthError).status).toBe(402);
  });

  test("400 -> HttpError immédiate (notre erreur, pas de rotation)", async () => {
    const { deps, calls } = fakeFetch([status(400, "bad request")]);
    await expect(chatJSON({ messages, models: CHAIN, parse }, deps)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  test("503 : au plus deux tentatives, même pour un modèle seul", async () => {
    const { deps, calls } = fakeFetch([status(503), status(503), status(503), status(503)]);
    await expect(chatJSON({ messages, models: ["a/one"], parse }, deps)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(2);
  });

  test("500 : 4 tentatives pour un modèle seul, 2 avec une chaîne", async () => {
    const single = fakeFetch([status(500), status(500), status(500), status(500)]);
    await expect(chatJSON({ messages, models: ["a/one"], parse }, single.deps)).rejects.toBeInstanceOf(HttpError);
    expect(single.calls).toHaveLength(4);

    const multi = fakeFetch([status(500), status(500), status(500)]);
    await expect(chatJSON({ messages, models: CHAIN, parse }, multi.deps)).rejects.toBeInstanceOf(HttpError);
    expect(multi.calls).toHaveLength(2);
  });

  test("JSON clôturé : parsé sans rotation", async () => {
    const { deps, calls } = fakeFetch([completion('```json\n{"x":2}\n```')]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.value).toEqual({ x: 2 });
    expect(r.rotated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("contenu inexploitable -> une seule rotation, chaîne amputée", async () => {
    const { deps, calls } = fakeFetch([completion("je ne sais pas"), completion('{"x":3}', { model: "b/two" })]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.value).toEqual({ x: 3 });
    expect(r.model).toBe("b/two");
    expect(r.rotated).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.model).toBe("b/two");
    expect(calls[1]!.body.models).toEqual(["b/two", "c/three"]);
  });

  test("contenu inexploitable deux fois -> LlmContentError", async () => {
    const { deps, calls } = fakeFetch([completion("?"), completion("??")]);
    await expect(chatJSON({ messages, models: CHAIN, parse }, deps)).rejects.toBeInstanceOf(LlmContentError);
    expect(calls).toHaveLength(2);
  });

  test("dernier modèle inexploitable : pas de rotation possible", async () => {
    const { deps, calls } = fakeFetch([completion("?")]);
    await expect(chatJSON({ messages, models: ["a/one"], parse }, deps)).rejects.toBeInstanceOf(LlmContentError);
    expect(calls).toHaveLength(1);
  });

  test("200 avec erreur dans le corps, contenu vide ou tronqué -> contenu inexploitable", async () => {
    for (const bad of [
      Response.json({ error: { code: 429, message: "provider limited" } }),
      completion(""),
      completion('{"x":', { choices: [{ message: { content: '{"x":' }, finish_reason: "length" }] }),
    ]) {
      const { deps } = fakeFetch([bad]);
      await expect(chatJSON({ messages, models: ["a/one"], parse }, deps)).rejects.toBeInstanceOf(LlmContentError);
    }
  });

  test("identifiant inconnu (400) : retiré de la chaîne, nouvelle requête", async () => {
    const bad = status(400, '{"error":{"message":"a/one is not a valid model ID","code":400}}');
    const { deps, calls } = fakeFetch([bad, completion('{"x":4}', { model: "b/two" })]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.value).toEqual({ x: 4 });
    expect(r.rotated).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.model).toBe("b/two");
    expect(calls[1]!.body.models).toEqual(["b/two", "c/three"]);
  });

  test("identifiant inconnu au milieu de la chaîne, puis un autre : deux retraits", async () => {
    const bad = (id: string) => status(400, `{"error":{"message":"${id} is not a valid model ID","code":400}}`);
    const { deps, calls } = fakeFetch([bad("b/two"), bad("c/three"), completion('{"x":5}')]);
    const r = await chatJSON({ messages, models: CHAIN, parse }, deps);
    expect(r.value).toEqual({ x: 5 });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.body.models).toEqual(["a/one", "c/three"]);
    expect(calls[2]!.body.models).toBeUndefined();
    expect(calls[2]!.body.model).toBe("a/one");
  });

  test("seul modèle inconnu : erreur remontée telle quelle", async () => {
    const bad = status(400, '{"error":{"message":"a/one is not a valid model ID","code":400}}');
    const { deps, calls } = fakeFetch([bad]);
    await expect(chatJSON({ messages, models: ["a/one"], parse }, deps)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  test("signal externe déjà annulé : aucun appel", async () => {
    const { deps, calls } = fakeFetch([completion('{"x":1}')]);
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(chatJSON({ messages, models: CHAIN, parse, signal: ac.signal }, deps)).rejects.toThrow("stop");
    expect(calls).toHaveLength(0);
  });

  test("clé absente -> erreur claire", async () => {
    const saved = Bun.env.OPENROUTER_API_KEY;
    delete Bun.env.OPENROUTER_API_KEY;
    try {
      await expect(chatJSON({ messages, models: CHAIN, parse })).rejects.toThrow("OPENROUTER_API_KEY");
    } finally {
      Bun.env.OPENROUTER_API_KEY = saved;
    }
  });
});

// --- postWithRetry ----------------------------------------------------------------

describe("postWithRetry", () => {
  test("erreur réseau réessayée puis abandon avec message", async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    await expect(
      postWithRetry("X", "http://x", {}, { attempts: 3, fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow("X unreachable after 3 attempt(s)");
    expect(n).toBe(3);
  });

  test("statut non réessayable -> HttpError avec corps", async () => {
    const fetchImpl = async () => status(403, "forbidden");
    const err = await postWithRetry("X", "http://x", {}, { fetchImpl, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).body).toBe("forbidden");
  });
});

// --- stats + coupe-circuit ---------------------------------------------------------

describe("recordCall / llmStatsSummary", () => {
  test("cumule et compte les replis (modèle ≠ tête de chaîne ou rotation)", () => {
    const s = newLlmStats();
    const base = { value: null, content: "", promptTokens: 10, completionTokens: 2, costUsd: 0.001, retries: 0, rotated: false };
    recordCall(s, { ...base, model: "a/one" }, CHAIN);
    recordCall(s, { ...base, model: "b/two", retries: 1 }, CHAIN);
    recordCall(s, { ...base, model: "a/one", rotated: true }, CHAIN);
    expect(s.calls).toBe(3);
    expect(s.fallbacks).toBe(2);
    expect(s.retries).toBe(1);
    expect(s.promptTokens).toBe(30);
    expect(s.costUsd).toBeCloseTo(0.003);
    expect(s.byModel).toEqual({ "a/one": 2, "b/two": 1 });
    expect(llmStatsSummary(s)).toBe("3 appels 0,003 $ (one ×2, two ×1) — 1 réessai, 2 replis");
  });
  test("formatUsd : décimales selon l'ordre de grandeur", () => {
    expect(formatUsd(0)).toBe("0,00 $");
    expect(formatUsd(0.00042)).toBe("0,0004 $");
    expect(formatUsd(0.0421)).toBe("0,042 $");
    expect(formatUsd(12.5)).toBe("12,50 $");
  });
});

describe("Breaker", () => {
  test("s'ouvre après N échecs consécutifs, un succès remet à zéro", () => {
    const b = new Breaker(3);
    b.failure(new Error("x"));
    b.failure(new Error("x"));
    b.success();
    b.failure(new Error("x"));
    b.failure(new Error("x"));
    expect(b.tripped).toBe(false);
    b.failure(new Error("boom"));
    expect(b.tripped).toBe(true);
    expect(b.reason).toContain("3 échecs LLM consécutifs");
    expect(b.reason).toContain("boom");
    expect(b.signal.aborted).toBe(true);
  });
  test("401/402 ouvrent immédiatement", () => {
    const b = new Breaker(5);
    b.failure(new LlmAuthError(402, "Insufficient credits"));
    expect(b.tripped).toBe(true);
    expect(b.reason).toContain("crédit OpenRouter épuisé");
  });
});

// --- classifyLLM avec contexte ------------------------------------------------------

const avis: Announcement = {
  idweb: "t-1",
  url: "https://example.com/1",
  publishedAt: "",
  deadline: null,
  objet: "Plan de mobilité",
  department: "75",
  acheteur: "Ville",
  typeAvis: "Avis de marché",
  procedure: "MAPA",
  raw: "Plan de mobilité",
};

describe("classifyLLM", () => {
  let ctx: LlmContext;
  beforeEach(() => {
    ctx = { models: CHAIN, stats: newLlmStats(), breaker: new Breaker(2) };
  });

  test("classement + modèle + stats", async () => {
    const { deps } = fakeFetch([completion('{"category":"relevant","reason":"plan"}', { model: "b/two" })]);
    ctx.deps = deps;
    const r = await classifyLLM(avis, ctx);
    expect(r).toEqual({ category: "relevant", reason: "plan", classifier: "b/two" });
    expect(ctx.stats.calls).toBe(1);
    expect(ctx.stats.fallbacks).toBe(1);
    expect(ctx.stats.errors).toBe(0);
  });

  test("catégorie invalide -> rotation vers le modèle suivant", async () => {
    const { deps, calls } = fakeFetch([
      completion('{"category":"peut-être"}'),
      completion('{"category":"excluded","reason":"hors scope"}', { model: "b/two" }),
    ]);
    ctx.deps = deps;
    const r = await classifyLLM(avis, ctx);
    expect(r.category).toBe("excluded");
    expect(calls[1]!.body.models).toEqual(["b/two", "c/three"]);
  });

  test("échecs consécutifs ouvrent le coupe-circuit, puis plus aucun appel", async () => {
    const { deps, calls } = fakeFetch([status(500), status(500), status(500), status(500), completion('{"category":"relevant"}')]);
    ctx.deps = deps;
    await expect(classifyLLM(avis, ctx)).rejects.toThrow();
    await expect(classifyLLM(avis, ctx)).rejects.toThrow();
    expect(ctx.breaker.tripped).toBe(true);
    expect(ctx.stats.errors).toBe(2);
    const before = calls.length;
    await expect(classifyLLM(avis, ctx)).rejects.toThrow("coupe-circuit");
    expect(calls.length).toBe(before);
  });

  test("402 ouvre le coupe-circuit au premier appel", async () => {
    const { deps } = fakeFetch([status(402, "Insufficient credits")]);
    ctx.deps = deps;
    await expect(classifyLLM(avis, ctx)).rejects.toBeInstanceOf(LlmAuthError);
    expect(ctx.breaker.tripped).toBe(true);
  });
});
