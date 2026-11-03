#!/bin/bash -l
# Scrape + classify + store, fired by clevercloud/cron.json (UTC):
#   04:30  full run with the digest email;
#   12:30  « midi » run: same read, no digest (SKIP_DIGEST=1) — notices
#          published in the morning show up the same afternoon, and a
#          failed morning run is retried without waiting for tomorrow.
#          What it finds stays « new » for the next morning's digest.
# The -l flag loads the app environment variables; crons run on every
# instance, so bail out on all but instance 0.
set -euo pipefail

if [ -n "${INSTANCE_NUMBER:-}" ] && [ "$INSTANCE_NUMBER" != "0" ]; then
  exit 0
fi

cd "${APP_HOME:-$(dirname "$0")/..}"
if [ "${1:-}" = "midi" ]; then
  SKIP_DIGEST=1 bun run src/run.ts
else
  bun run src/run.ts
fi
