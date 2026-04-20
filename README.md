# avis-en-cours

Scrape a public procurement portal for currently-open SERVICES-type avis relevant to a mobility-planning consultancy, and classify each one as **relevant**, **travaux** (works), or **excluded** (out-of-domain).

Built with Bun + TypeScript + Playwright. Optional semantic classification via the Mistral API.

## What it does

1. Runs a list of French keyword searches (`mobilité`, `vélo`, `stationnement`, `schéma directeur ET mobilité`, …) against the configured portal with fixed filters: `type_marche=SERVICES`, statut *en cours*, toutes départements.
2. Paginates results via the `start=N` query param and extracts structured fields (id, objet, acheteur, département, date limite, type d'avis, procédure) from the Angular-rendered result cards.
3. Caches the raw scrape to `.cache/scrape.json` so classifier tweaks don't re-hit the site.
4. Classifies each avis into `relevant` / `travaux` / `excluded` and writes two markdown reports (`avis-en-cours.md`, `avis-travaux.md`). Excluded avis are logged to stderr with their reason.

## Install

```bash
bun install
bun run install:browsers   # Chromium for Playwright
cp .env.example .env       # then edit — see below
```

## Environment

Everything goes in `.env` (auto-loaded by Bun):

| Variable            | Required | Default                              | Notes                                                                       |
| ------------------- | -------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `PORTAL_BASE_URL`   | **yes**  | —                                    | Search base URL of the target portal. Fails at startup if missing.          |
| `MISTRAL_API_KEY`   | no       | —                                    | Enables semantic (LLM) and hybrid classifier modes.                         |
| `MISTRAL_MODEL`     | no       | `mistral-small-latest`               | Any Mistral chat model id.                                                  |
| `CLASSIFIER`        | no       | `hybrid` if key set, else `regex`    | Override: `regex` \| `llm` \| `hybrid`.                                     |
| `MAX_PAGES`         | no       | `3`                                  | Pages per keyword search (10 items/page).                                   |
| `USE_CACHE`         | no       | unset                                | `1` skips the scrape and re-runs classification on `.cache/scrape.json`.    |
| `HEADLESS`          | no       | `true`                               | Set `false` to watch the browser.                                           |
| `TIMEOUT_MS`        | no       | `30000`                              | Default Playwright operation timeout.                                       |

## Run

```bash
# fresh scrape + classify + write reports
bun run src/index.ts

# same, capping each keyword at 5 pages
MAX_PAGES=5 bun run src/index.ts

# re-classify using the cached scrape (fast, ~seconds)
USE_CACHE=1 bun run src/index.ts

# force a specific classifier
CLASSIFIER=regex USE_CACHE=1 bun run src/index.ts
```

## Classifier modes

- **`regex`** — deterministic rules in `src/classify.ts`. Free, instant, reproducible. Good at hard rules (télécom, contrôle de travaux, assurances…). Bad at nuance.
- **`llm`** — one Mistral call per avis with a few-shot French prompt (`src/classify-llm.ts`). Good at semantic distinctions (e.g. "restructuration des services" vs. physical restructuring). Adds ~€0.01/run and some non-determinism. Occasionally misses hard rules.
- **`hybrid`** (default when `MISTRAL_API_KEY` is set) — regex first. If the regex confidently labels an avis `excluded` or `travaux`, that stands. Otherwise the LLM makes the final call. Best of both: hard rules are enforced deterministically, borderline cases get semantic judgement. Only the ~15–20 items that pass regex go to the LLM.

## Customising the scope

The scope is hard-coded for mobility-planning consultancy work. Two places to edit:

- **Regex rules** — `src/classify.ts`: hard exclusions (télécom, contrôle de travaux, operator procurement, etc.) and travaux patterns (MOE, rénovation, fouilles, reconnaissance géotechnique).
- **LLM prompt** — `src/classify-llm.ts`: the system prompt describing in-scope vs. out-of-scope work, plus a few-shot of labelled examples.

Both files are intentionally small and self-contained. Fork and tweak.

## File layout

```
src/
  browser.ts          Playwright session lifecycle
  config.ts           Runtime config (headless, timeout, UA)
  defaults.ts         Default search params: type_marche=SERVICES, statut en cours
  params.ts           Typed SearchParams + URL builder
  scraper.ts          Result-card extraction via Angular ng-bind selectors
  classify.ts         Regex classifier
  classify-llm.ts     Mistral classifier (system prompt + few-shot)
  classify-hybrid.ts  Regex-then-LLM composition
  report.ts           Markdown renderer
  index.ts            Entry point: scrape → classify → write reports
.cache/               Gitignored scrape cache
```

The two markdown reports (`avis-en-cours.md`, `avis-travaux.md`) are per-run outputs and are gitignored.

## License

No license specified yet. Add one before publishing if you want others to reuse the code.
