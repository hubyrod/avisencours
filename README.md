# avis-en-cours

Query a public OpenDataSoft (ODS) procurement portal for currently-open SERVICES-type avis relevant to a mobility-planning consultancy, and classify each one as **relevant**, **travaux** (works), or **excluded** (out-of-domain).

Built with Bun + TypeScript. Hits the portal's REST API directly — no browser, no scraping. Optional semantic classification through [OpenRouter](https://openrouter.ai) (any model, with a fallback chain and price-sorted providers).

Two ways to use it:

- **Local CLI** (`bun run src/index.ts`) — writes timestamped markdown reports, as before.
- **Deployed service** (Clever Cloud) — daily cron run stored in PostgreSQL, a French web dashboard with passwordless email-code login (`src/server.ts` + `src/auth.ts`), and a daily email digest via MailPace (`src/run.ts`). See [Deployment](#deployment-clever-cloud).

## What it does

1. Builds a single ODS v2.1 `where=` clause combining a French keyword OR (`mobilité OR vélo OR stationnement OR "schéma directeur" …`) with a date filter (`datelimitereponse >= today` or `datefindiffusion >= today` when no deadline is set).
2. Pages through every matching record (limit 100/req, sorted by deadline ASC), extracts structured fields (id, objet, acheteur, département, date limite, type d'avis, procédure) and caches the lot to `.cache/scrape.json`.
3. Classifies each avis into `relevant` / `travaux` / `excluded`. Writes two timestamped markdown reports per run (`avis-en-cours-YYYY-MM-DD-HH-MM-SS.md` and the travaux equivalent). Excluded avis are logged to stderr with their reason.

Deployed, the same pipeline runs daily into PostgreSQL behind a French dashboard (passwordless email-code login). Each avis has a detail page with a **live comment thread** and a **collaborative status** (« à évaluer », « répondu », « gagné »… — list editable by admins on `/admin`, every change kept as history in the thread). The dashboard filters by status and can hide rejected avis. `/configuration` (admins, or users delegated the right from `/admin`) edits the pipeline live: search keywords, « toujours garder / toujours exclure » rules, classifier mode, LLM model chain (with live OpenRouter prices), digest window, départements, plus a « Relancer maintenant » button. Threads update in real time through the [Skip](https://skiplabs.io) reactive engine running in-process (WASM) on Postgres LISTEN/NOTIFY; set `LIVE_COMMENTS=0` to disable it (threads then show as unavailable). `/sante` reports `live` (engine up) and `livePg` (its Postgres connection + number of watched tables).

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
| `OPENROUTER_API_KEY` | no      | —                                    | Enables semantic (LLM) and hybrid classifier modes.                         |
| `LLM_MODELS`        | no       | `mistralai/mistral-nemo,…` (see `src/defaults.ts`) | Comma-separated OpenRouter model ids, fallback order (max 5). Overridden by the `/configuration` setting. |
| `LLM_MAX_PRICE_PER_M` | no     | `1`                                  | Price cap, USD per million tokens, applied to every model of the chain.     |
| `OPENROUTER_BASE_URL` | no     | `https://openrouter.ai/api/v1`       | Override for tests / a proxy.                                               |
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

A full run hits the portal API ~30 times (~3 minutes for ~3 000 records over a 14-keyword query) and adds a fraction of a cent of OpenRouter credit per run with the default chain when the hybrid classifier is on (the exact cost, token counts and which models answered are recorded on each run and shown on `/configuration` and in the digest footer). Each call carries the whole model chain: OpenRouter switches to the next model on outage, rate limit, moderation or context overflow, and the client retries timeouts / 5xx and re-asks the rest of the chain once when a model returns unusable JSON. A dead key, an empty credit or five consecutive chain failures open a circuit breaker: the rest of the run is classified by regex, the run is flagged with a warning, `ALERT_RECIPIENT` gets an email, and the digest is held until the next healthy run.

## Checks

```bash
bun run typecheck && bun run lint && bun test && bun run build   # what CI runs
TEST_DATABASE_URL=postgresql://<user>@localhost:5432/avis_test bun test live.integration
```

The unit tests are pure logic (no DB, no network). The second line runs the live-engine integration tests against a throwaway local Postgres (`createdb avis_test`): they boot the Skip engine, subscribe to a thread over SSE, write comments and status changes, kill the engine's Postgres connection with `pg_terminate_backend` and check the thread keeps updating. They are skipped when `TEST_DATABASE_URL` is unset (CI has no DB), so run them locally before touching the Skip packages, their patch, or `src/live.ts`.

## Classifier modes

- **`regex`** — deterministic rules in `src/classify.ts`. Free, instant, reproducible. Good at hard rules (télécom, contrôle de travaux, assurances…). Bad at nuance.
- **`llm`** — one OpenRouter call per avis with a few-shot French prompt (`src/classify-llm.ts`, prompt tuned on mistral-small). Good at semantic distinctions (e.g. "restructuration des services" vs. physical restructuring). Cheap but adds some non-determinism. Occasionally misses hard rules.
- **`hybrid`** (default when `OPENROUTER_API_KEY` is set) — regex first. If the regex confidently labels an avis `excluded` or `travaux`, that stands. Otherwise the LLM makes the final call. Best of both: hard rules are enforced deterministically, borderline cases get semantic judgement. Only the items that pass regex go to the LLM.

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
  classify-llm.ts     LLM classifier (system prompt + few-shot, per-run context: chain, stats, breaker)
  llm.ts              OpenRouter client: fallback chain, price-sorted providers, retries, stats, circuit breaker
  http.ts             postWithRetry shared by llm.ts and email.ts (retries statuses, timeouts and network errors)
  openrouter-catalog.ts  Public model catalog (prices, JSON support) + key credit, for /configuration
  eval-llm.ts         `bun run eval`: labelled set × candidate models → accuracy, cost, latency
  classify-hybrid.ts  Regex-then-LLM composition
  pipeline.ts         Shared core: fetch → dedupe → classify (used by CLI and server)
  report.ts           Markdown renderer (sorted by deadline)
  index.ts            Local CLI: pipeline → write markdown reports
  rules.ts            « toujours garder / exclure » substring rules applied before the classifier
  db.ts               PostgreSQL (Bun.sql): schema, run tracking, upserts, dashboard queries
  auth.ts             Passwordless auth: email OTP codes, opaque session cookies, users, rate limits
  run.ts              Daily job: pipeline → upsert DB → email digest (alerts on failure)
  email.ts            MailPace sender + French digest/alert/login-code HTML
  live.ts             Live threads: Skip reactive graph over Postgres LISTEN/NOTIFY + SSE relay
  router.ts           Tiny path matcher for routes with :param segments
  server.ts           Dashboard + login + admin/configuration pages (Bun.serve) + /sante health endpoint
  *.test.ts           Unit tests; live.integration.test.ts needs TEST_DATABASE_URL (see Checks)
patches/              Local patch to @skip-adapter/postgres (reconnects after a dropped LISTEN connection)
clevercloud/
  cron.json           Daily schedule (04:30 UTC)
  daily-run.sh        Cron entry: env-loading wrapper around src/run.ts
.cache/               Gitignored scrape cache (raw API output)
```

Per-run outputs (`avis-en-cours-*.md`, `avis-travaux-*.md`) are gitignored.

## Deployment (Clever Cloud)

One **Node.js app** (Bun is auto-detected from `bun.lock`; `scripts.start` serves the dashboard on port 8080) plus a **PostgreSQL add-on**. The Clever Cloud filesystem is ephemeral — PostgreSQL is the source of truth.

1. Create a Node.js application (1 instance, smallest size, disable autoscaling) and a PostgreSQL add-on (DEV plan), and link them — this injects `POSTGRESQL_ADDON_URI`.
2. **Email first**: MailPace token with a DKIM-verified sending domain (the add-on injects no env var — copy the token manually). Login is by emailed code, so a deployed app without working email is unreachable. Smoke-test the token with a curl to `https://app.mailpace.com/api/v1/send` before deploying; a 403 means the domain is not verified.
3. Set the env vars from `.env.example`: portal vars, `OPENROUTER_API_KEY` (set it **before** the push: the cron and the « Relancer maintenant » button inherit the app env), `MAILPACE_API_TOKEN`, `EMAIL_FROM`, `OTP_PEPPER`, `ADMIN_EMAILS` (your email — seeded as admin at startup), `ALERT_RECIPIENT`, `DASHBOARD_URL`.
4. `clever deploy`. Tables are created automatically at startup; `ADMIN_EMAILS` accounts are upserted as admins.
5. Log in at `/connexion` with your email code, then add teammates from `/admin`.
6. The cron (`clevercloud/cron.json`) fires every day at 04:30 UTC: scrape → classify → store → digest email. On failure, `ALERT_RECIPIENT` gets an alert email and the dashboard banner turns red.

The daily digest goes to users who ticked the opt-in on `/profil`; it is sent every day even when empty — if it stops arriving, something is wrong. It is skipped (with a log line) when `MAILPACE_API_TOKEN` is unset or nobody opted in.

## License

No license specified yet. Add one before publishing if you want others to reuse the code.
