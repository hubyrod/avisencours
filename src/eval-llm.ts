// Banc d'essai des modèles : rejoue un jeu d'avis étiquetés à la main
// (eval/avis.jsonl) sur chaque modèle candidat, seul (sans chaîne de repli),
// et imprime exactitude, confusions, échecs JSON, coût et latence médiane.
// C'est le garde-fou avant de mettre un modèle moins cher en tête de chaîne.
//
//   bun run eval                               # modèles de la chaîne par défaut / LLM_MODELS
//   bun run eval mistralai/mistral-nemo openai/gpt-4.1-nano
//   bun run eval --verbose …                   # liste les erreurs de classement
//   bun run eval --export                      # écrit eval/candidates.jsonl depuis .cache/scrape.json
//                                              # (à étiqueter puis coller dans eval/avis.jsonl)
import { classifyLLM, type LlmContext } from "./classify-llm.ts";
import { Breaker, defaultModelChain, formatUsd, llmConfigured, newLlmStats } from "./llm.ts";
import { errMessage } from "./http.ts";
import type { Announcement } from "./scraper.ts";
import type { Category } from "./classify.ts";

const CASES_PATH = "eval/avis.jsonl";
const CANDIDATES_PATH = "eval/candidates.jsonl";
const CATEGORIES: Category[] = ["relevant", "travaux", "excluded"];

type EvalCase = {
  idweb: string;
  objet: string;
  typeAvis?: string;
  acheteur?: string;
  procedure?: string;
  raw?: string;
  expected: Category;
  note?: string;
};

function toAnnouncement(c: EvalCase): Announcement {
  return {
    idweb: c.idweb,
    url: `https://www.boamp.fr/pages/avis/?q=idweb:${c.idweb}`,
    publishedAt: "",
    deadline: null,
    objet: c.objet,
    department: "",
    acheteur: c.acheteur ?? "Collectivité",
    typeAvis: c.typeAvis ?? "Avis de marché",
    procedure: c.procedure ?? "Procédure adaptée",
    raw: c.raw ?? c.objet,
  };
}

async function loadCases(): Promise<EvalCase[]> {
  const text = await Bun.file(CASES_PATH).text();
  const cases: EvalCase[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const c = JSON.parse(line) as EvalCase;
    if (!CATEGORIES.includes(c.expected)) {
      throw new Error(`${CASES_PATH}:${i + 1}: expected invalide « ${c.expected} »`);
    }
    cases.push(c);
  }
  return cases;
}

async function exportCandidates(): Promise<void> {
  const f = Bun.file(".cache/scrape.json");
  if (!(await f.exists())) throw new Error(".cache/scrape.json absent — lancez d'abord bun run src/index.ts");
  const items = (await f.json()) as Announcement[];
  const lines = items.map((a) =>
    JSON.stringify({
      idweb: a.idweb,
      objet: a.objet,
      typeAvis: a.typeAvis,
      acheteur: a.acheteur,
      procedure: a.procedure,
      raw: a.raw.slice(0, 1200),
      expected: "",
    }),
  );
  await Bun.write(CANDIDATES_PATH, lines.join("\n") + "\n");
  console.error(`${lines.length} candidats écrits dans ${CANDIDATES_PATH} — remplir "expected" puis copier dans ${CASES_PATH}`);
}

async function mapConcurrent<T, R>(items: T[], fn: (t: T) => Promise<R>, n: number): Promise<R[]> {
  // oxlint-disable-next-line no-new-array -- slots filled by index
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

type Outcome = { c: EvalCase; predicted: Category | null; reason?: string; ms: number; error?: string };

type ModelReport = {
  model: string;
  outcomes: Outcome[];
  correct: number;
  failures: number;
  confusion: Record<string, number>;
  costUsd: number;
  p50: number;
};

async function evalModel(model: string, cases: EvalCase[]): Promise<ModelReport> {
  const ctx: LlmContext = { models: [model], stats: newLlmStats(), breaker: new Breaker(1000) };
  const outcomes = await mapConcurrent(
    cases,
    async (c): Promise<Outcome> => {
      const t0 = performance.now();
      try {
        const r = await classifyLLM(toAnnouncement(c), ctx);
        return { c, predicted: r.category, reason: r.reason, ms: performance.now() - t0 };
      } catch (err) {
        return { c, predicted: null, ms: performance.now() - t0, error: errMessage(err) };
      }
    },
    5,
  );
  const confusion: Record<string, number> = {};
  let correct = 0;
  let failures = 0;
  for (const o of outcomes) {
    if (o.predicted === null) failures++;
    else if (o.predicted === o.c.expected) correct++;
    else confusion[`${o.c.expected}→${o.predicted}`] = (confusion[`${o.c.expected}→${o.predicted}`] ?? 0) + 1;
  }
  const times = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? 0;
  return { model, outcomes, correct, failures, confusion, costUsd: ctx.stats.costUsd, p50 };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--export")) return exportCandidates();
  const verbose = args.includes("--verbose");
  const models = args.filter((a) => !a.startsWith("--"));
  const chain = models.length ? models : defaultModelChain();

  if (!llmConfigured()) throw new Error("OPENROUTER_API_KEY not set");
  const cases = await loadCases();
  console.error(`${cases.length} cas, ${chain.length} modèle(s) : ${chain.join(", ")}\n`);

  const reports: ModelReport[] = [];
  for (const m of chain) {
    process.stderr.write(`${m} … `);
    const r = await evalModel(m, cases);
    reports.push(r);
    console.error(`${r.correct}/${cases.length}`);
  }

  console.log();
  console.log(
    pad("modèle", 44) + pad("exact", 14) + pad("échecs", 8) + pad("coût", 11) + pad("p50", 9) + "confusions",
  );
  for (const r of reports) {
    const pct = Math.round((100 * r.correct) / cases.length);
    const conf = Object.entries(r.confusion)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`)
      .join(", ");
    console.log(
      pad(r.model, 44) +
        pad(`${r.correct}/${cases.length} (${pct} %)`, 14) +
        pad(String(r.failures), 8) +
        pad(formatUsd(r.costUsd), 11) +
        pad(`${Math.round(r.p50)} ms`, 9) +
        conf,
    );
  }
  if (verbose) {
    for (const r of reports) {
      const wrong = r.outcomes.filter((o) => o.predicted !== o.c.expected);
      if (wrong.length === 0) continue;
      console.log(`\n--- ${r.model}`);
      for (const o of wrong) {
        console.log(
          `  [${o.c.idweb}] attendu ${o.c.expected}, obtenu ${o.predicted ?? "ÉCHEC"} — ${o.c.objet.slice(0, 90)}` +
            (o.reason ? `\n      ↳ ${o.reason}` : "") +
            (o.error ? `\n      ↳ ${o.error}` : "") +
            (o.c.note ? `\n      (note : ${o.c.note})` : ""),
        );
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
