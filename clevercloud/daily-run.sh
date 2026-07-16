#!/bin/bash -l
# Daily scrape + classify + digest. Fired by clevercloud/cron.json (UTC).
# The -l flag loads the app environment variables; crons run on every
# instance, so bail out on all but instance 0.
set -euo pipefail

if [ -n "${INSTANCE_NUMBER:-}" ] && [ "$INSTANCE_NUMBER" != "0" ]; then
  exit 0
fi

cd "${APP_HOME:-$(dirname "$0")/..}"
bun run src/run.ts
