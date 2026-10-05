import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

// Loads the project .env for the Prisma CLI without overriding variables that are already set, so a
// one-off `DATABASE_URL=<remote> prisma migrate deploy` targets that database. Kept inline (no src/
// import) so the config also works inside the runtime image. Docker/Render have no .env file.
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` does not need a live database; migrate/deploy do.
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
