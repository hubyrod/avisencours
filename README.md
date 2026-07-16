# avis-en-cours

Query a public OpenDataSoft (ODS) procurement portal for currently-open SERVICES-type avis relevant to a mobility-planning consultancy, and classify each one as **relevant**, **travaux** (works), or **excluded** (out-of-domain).

Built with Bun + TypeScript. Hits the portal's REST API directly — no browser, no scraping. Optional semantic classification via the Mistral API.

Two ways to use it:

- **Local CLI** (`bun run src/index.ts`) — writes timestamped markdown reports, as before.
- **Deployed service** (Clever Cloud) — daily cron run stored in PostgreSQL, a French web dashboard behind Basic Auth (`src/server.ts`), and a daily email digest via Brevo (`src/run.ts`). See [Deployment](#deployment-clever-cloud).

## What it does

1. Builds a single ODS v2.1 `where=` clause combining a French keyword OR (`mobilité OR vélo OR stationnement OR "schéma directeur" …`) with a date filter (`datelimitereponse >= today` or `datefindiffusion >= today` when no deadline is set).
2. Pages through every matching record (limit 100/req, sorted by deadline ASC), extracts structured fields (id, objet, acheteur, département, date limite, type d'avis, procédure) and caches the lot to `.cache/scrape.json`.
3. Classifies each avis into `relevant` / `travaux` / `excluded`. Writes two timestamped markdown reports per run (`avis-en-cours-YYYY-MM-DD-HH-MM-SS.md` and the travaux equivalent). Excluded avis are logged to stderr with their reason.

## Install

```bash
bun install
cp .env.example .env       # then edit — see below
```

That's it — no browser binaries needed.

## Environment

Everything goes in `.env` (auto-loaded by Bun):

| Variable            | Required | Default                              | Notes                                                                       |
| ------------------- | -------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `PORTAL_API_URL`    | **yes**  | —                                    | ODS v2.1 datasets base URL, no trailing slash. e.g. `https://<portal>/api/explore/v2.1/catalog/datasets`. |
| `PORTAL_DATASET`    | **yes**  | —                                    | Dataset id. Run will fail at startup if either is unset.                    |
| `MISTRAL_API_KEY`   | no       | —                                    | Enables semantic (LLM) and hybrid classifier modes.                         |
| `MISTRAL_MODEL`     | no       | `mistral-small-latest`               | Any Mistral chat model id.                                                  |
| `CLASSIFIER`        | no       | `hybrid` if key set, else `regex`    | Override: `regex` \| `llm` \| `hybrid`.                                     |
| `MAX_PAGES`         | no       | `100`                                | Pagination cap (100 items/page). Stops earlier when results are exhausted.  |
| `USE_CACHE`         | no       | unset                                | `1` skips the API and re-runs classification on `.cache/scrape.json`.       |

## Run

```bash
# fresh fetch + classify + write reports
bun run src/index.ts

# pass a custom OR-query (overrides the default keyword list)
bun run src/index.ts "mobilité OR cyclable OR stationnement"

# re-classify using the cached scrape (fast, ~seconds)
USE_CACHE=1 bun run src/index.ts

# force a specific classifier
CLASSIFIER=regex USE_CACHE=1 bun run src/index.ts
```

A full run hits the portal API ~30 times (~3 minutes for ~3 000 records over a 14-keyword query) and adds ~€0.01 of Mistral spend per run when the hybrid classifier is on. The classifier retries 408/429/5xx up to four times with exponential backoff so a flaky API doesn't tank the run.

## Classifier modes

- **`regex`** — deterministic rules in `src/classify.ts`. Free, instant, reproducible. Good at hard rules (télécom, contrôle de travaux, assurances…). Bad at nuance.
- **`llm`** — one Mistral call per avis with a few-shot French prompt (`src/classify-llm.ts`). Good at semantic distinctions (e.g. "restructuration des services" vs. physical restructuring). Adds ~€0.01/run and some non-determinism. Occasionally misses hard rules.
- **`hybrid`** (default when `MISTRAL_API_KEY` is set) — regex first. If the regex confidently labels an avis `excluded` or `travaux`, that stands. Otherwise the LLM makes the final call. Best of both: hard rules are enforced deterministically, borderline cases get semantic judgement. Only the items that pass regex go to the LLM.

## Customising the scope

The scope is hard-coded for mobility-planning consultancy work. Three places to edit:

- **Keyword list** — `src/defaults.ts`: the `KEYWORDS` array gets OR'd into a single `where=` clause.
- **Regex rules** — `src/classify.ts`: hard exclusions (télécom, contrôle de travaux, operator procurement, etc.) and travaux patterns (MOE, rénovation, fouilles, reconnaissance géotechnique).
- **LLM prompt** — `src/classify-llm.ts`: the system prompt describing in-scope vs. out-of-scope work, plus a few-shot of labelled examples.

All three files are intentionally small and self-contained. Fork and tweak.

## File layout

```
src/
  defaults.ts         KEYWORDS list + default search params (type_marche=SERVICES, deadline>=today)
  params.ts           SearchParams type + ODS v2.1 URL builder (where= with search() + date filter)
  scraper.ts          Paginated fetch loop + ODS record → Announcement mapping
  classify.ts         Regex classifier (normalise, hard exclusions, travaux patterns)
  classify-llm.ts     Mistral classifier (system prompt + few-shot, retry on 5xx)
  classify-hybrid.ts  Regex-then-LLM composition
  pipeline.ts         Shared core: fetch → dedupe → classify (used by CLI and server)
  report.ts           Markdown renderer (sorted by deadline)
  index.ts            Local CLI: pipeline → write markdown reports
  db.ts               PostgreSQL (Bun.sql): schema, run tracking, upserts, dashboard queries
  run.ts              Daily job: pipeline → upsert DB → email digest (alerts on failure)
  email.ts            Brevo sender + French digest/alert HTML
  server.ts           Dashboard (Bun.serve, Basic Auth) + /sante health endpoint
clevercloud/
  cron.json           Daily schedule (04:30 UTC)
  daily-run.sh        Cron entry: env-loading wrapper around src/run.ts
.cache/               Gitignored scrape cache (raw API output)
```

Per-run outputs (`avis-en-cours-*.md`, `avis-travaux-*.md`) are gitignored.

## Deployment (Clever Cloud)

One **Node.js app** (Bun is auto-detected from `bun.lock`; `scripts.start` serves the dashboard on port 8080) plus a **PostgreSQL add-on**. The Clever Cloud filesystem is ephemeral — PostgreSQL is the source of truth.

1. Create a Node.js application (1 instance, smallest size, disable autoscaling) and a PostgreSQL add-on (DEV plan), and link them — this injects `POSTGRESQL_ADDON_URI`.
2. Set the env vars from `.env.example`: portal + Mistral vars, `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` (shared team login), and for emails `BREVO_API_KEY`, `EMAIL_FROM` (verified sender in Brevo), `DIGEST_RECIPIENTS`, `ALERT_RECIPIENT`, `DASHBOARD_URL`.
3. `git push` to the Clever Cloud remote (or `clever deploy`). Tables are created automatically at startup.
4. The cron (`clevercloud/cron.json`) fires every day at 04:30 UTC: scrape → classify → store → digest email. On failure, `ALERT_RECIPIENT` gets an alert email and the dashboard banner turns red.
5. First run can be triggered manually: `clever ssh` then `bun run src/run.ts` (or wait for the next morning).

Emails are skipped (with a log line) when `BREVO_API_KEY`/`DIGEST_RECIPIENTS` are unset, so the dashboard can be deployed before the email setup. The digest is sent every day even when empty — if it stops arriving, something is wrong.

## License

No license specified yet. Add one before publishing if you want others to reuse the code.
