# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`avis-en-cours`: queries a public OpenDataSoft (ODS v2.1) procurement portal REST API for currently-open SERVICES-type French public tenders (avis), then classifies each as **relevant** (mobility-planning consultancy studies), **travaux** (works — out of scope), or **excluded** (out-of-domain). Bun + TypeScript, no test suite, no build step.

It runs two ways: a **local CLI** (`src/index.ts`, writes markdown reports) and a **deployed service on Clever Cloud** (daily cron → PostgreSQL → French dashboard with passwordless email-code login + MailPace email digest). See README "Deployment" for the runbook.

## Commands

```bash
bun install                              # setup (also: cp .env.example .env and edit)
bun run src/index.ts                     # CLI run: fetch → classify → write markdown reports
bun run src/index.ts "mobilité OR vélo"  # custom OR-query (replaces default keyword list)
USE_CACHE=1 bun run src/index.ts         # re-classify from .cache/scrape.json, no API fetch (fast — use this when iterating on classifiers)
CLASSIFIER=regex USE_CACHE=1 bun run src/index.ts  # force classifier: regex | llm | hybrid
bun run run:daily                        # server-side daily job: fetch → Postgres → digest email (needs POSTGRESQL_ADDON_URI; always fetches fresh, no cache)
bun run start                            # dashboard server on :8080 (needs POSTGRESQL_ADDON_URI; set ADMIN_EMAILS to seed an admin)
bun run typecheck                        # tsc --noEmit
bun run lint                             # oxlint src
bun test                                 # unit tests (src/*.test.ts — pure logic only, no DB/network)
bun run build                            # bundling smoke check (bun build → dist/, gitignored)
```

CI (`.github/workflows/ci.yml`) runs those four checks on every push/PR to `main`, then deploys to Clever Cloud (`clever deploy --alias server`, authenticated via `CLEVER_TOKEN`/`CLEVER_SECRET` repo secrets) and curls `/sante` until healthy. Pushing to `main` on GitHub = deploying to production.

`PORTAL_API_URL` and `PORTAL_DATASET` are required for anything that fetches (checked when the API URL is built, in `src/params.ts`). `MISTRAL_API_KEY` is optional; without it the classifier silently falls back to `regex`. Email vars (`MAILPACE_API_TOKEN`…) are optional in dev — the daily job logs and skips emails, and login codes are printed to stderr instead of sent (in production working email is mandatory: login happens by emailed code). `OTP_PEPPER` is required in production (production = `DASHBOARD_URL` starts with `https://`). See `.env.example` for the full list.

A fresh (non-cached) run takes ~3 minutes and ~30 API calls; hybrid/llm modes spend ~€0.01 of Mistral credit. Prefer `USE_CACHE=1` during development. For local DB testing, a throwaway Postgres database + `POSTGRESQL_ADDON_URI=postgresql://<user>@localhost:5432/<db>` works; tables are auto-created.

## Architecture

Shared pipeline in `src/pipeline.ts` (`runPipeline()`): scrape (or load cache) → dedupe by `idweb` → drop attribution/résultat/annulation notices → classify each avis into relevant/travaux/excluded. Two consumers:

- `src/index.ts` (CLI) — writes two timestamped markdown reports (`avis-en-cours-<stamp>.md`, `avis-travaux-<stamp>.md`; gitignored). Excluded avis only go to stderr with their reason.
- `src/run.ts` (daily job, fired by `clevercloud/cron.json` → `daily-run.sh`) — takes a Postgres advisory lock (skips if a run is in flight), records a row in `runs`, upserts every avis into `announcements` (`ON CONFLICT (idweb)` updates everything except `first_seen_*`), then sends the MailPace digest ("new" = `first_seen_run_id` = this run; sent daily even when empty, as a heartbeat). Digest recipients = users who opted in via `receive_digest` (default false, toggled on `/profil`). The digest itself goes out every day to those recipients, even when there is nothing new (subject « pas de nouvel avis »). On failure: run marked `error` + alert email to `ALERT_RECIPIENT`.

`src/server.ts` serves the dashboard: "current" tenders = `last_seen_run_id` = latest successful run AND deadline not passed, sorted by deadline; "Nouveau" badge = first seen in that run. `/sante` is public health JSON; everything else requires login.

**Auth** (`src/auth.ts`, modeled on Hugo's `chambre` project): passwordless — users request a 6-digit code by email (`/connexion`), codes are HMAC-peppered (`OTP_PEPPER`), 5-min TTL, max 5 attempts, 60s resend gate, anti-enumeration (same response whether the account exists). Sessions are opaque tokens (SHA-256 hash stored in `sessions`, raw token only in the cookie — `__Host-session`, HttpOnly, SameSite=Lax, 30-day rolling expiry with 1h-throttled touch). Accounts are admin-created (`/admin`, `is_admin` flag) or auto-provisioned at first login for emails on `ALLOWED_EMAIL_DOMAINS` (comma-separated, exact domain match, never admin); `ADMIN_EMAILS` env is upserted as admin at startup (grant-only). CSRF = SameSite=Lax + Origin-header check on POST. Rate limits are in-memory (fine: 1 instance). `src/db.ts` holds the schema (5 tables: `runs`, `announcements`, `users`, `sessions`, `email_verification_codes`), created idempotently at startup — there is no separate migration system. DB access uses Bun's built-in `Bun.sql` (no npm deps). Deadline is stored both as text (`deadline_text`, the scraper's `dd/mm/yyyy à HHhMM` format) and parsed (`deadline` timestamptz, parsed back from that text in `db.ts`).

- `src/params.ts` — builds the ODS v2.1 URL: keyword OR-query becomes a `where=` clause of `search(*, "...")` expressions, ANDed with a date filter (`datelimitereponse >= today`, falling back to `datefindiffusion` when no deadline).
- `src/scraper.ts` — paginated fetch (100/page), maps ODS records to `Announcement`. The `raw` field concatenates objet + nested JSON fields (`donnees`, `gestion`) + buyer/type/procedure — classifiers match against `raw`, not just `objet`.
- `src/classify.ts` — regex classifier. Order matters: hard exclusions (contrôle de travaux, contrôle qualité de service, télécom, VRD) → the large `EXCLUDE_HORS_DOMAINE` list → `isAMOForWorks` (AMO + works-verb + infra-noun ⇒ travaux) → `TRAVAUX` patterns → default relevant. All matching is on accent-stripped lowercase text (see `normalize`), so write patterns without accents.
- `src/classify-llm.ts` — one Mistral call per avis (French system prompt + few-shot, JSON output, temperature 0, retry with backoff on 408/429/5xx).
- `src/classify-hybrid.ts` — regex first; only avis the regex leaves as `relevant` go to the LLM. Default mode when the Mistral key is set.
- LLM/hybrid classification runs at concurrency 5; a per-item classification error defaults the avis to `relevant` ("revue manuelle") rather than dropping it.

## Domain scope (what "relevant" means)

The client is a mobility-planning consultancy that does **studies only**: plans de mobilité, schémas directeurs (cyclable, piéton), traffic modelling, parking/circulation studies, socio-economic evaluation, AMO for elaborating plans/studies. Not in scope: any works (MOE, construction), AMO tied to building a physical structure, transport operation (DSP, autocars, transport scolaire), telecom (never confuse "mobilité" with mobile phones), VRD, operational service-quality audits.

When adjusting scope, three files must stay consistent: the `KEYWORDS` search list in `src/defaults.ts`, the regex rules in `src/classify.ts`, and the LLM system prompt + few-shot examples in `src/classify-llm.ts`. A scope change usually touches at least the last two.
