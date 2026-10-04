#!/bin/sh
# Container entrypoint: apply pending database migrations, then start the app.
# Set RUN_MIGRATIONS=false when a separate one-shot migration step runs them (docker-compose).
set -e
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  npx --no-install prisma migrate deploy
fi
exec node dist/main.js
