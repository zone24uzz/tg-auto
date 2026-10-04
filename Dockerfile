# syntax=docker/dockerfile:1.7

# ── deps + build ─────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

# ── one-shot migration image (has the Prisma CLI) ────────────
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

# ── runtime ──────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# ffmpeg/ffprobe for voice, video and video-note processing
RUN apk add --no-cache ffmpeg tini \
  && addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production \
    MEDIA_TMP_DIR=/app/data/tmp \
    STORAGE_LOCAL_DIR=/app/data/storage
COPY package.json package-lock.json ./
# Production deps include the Prisma CLI so the container can apply migrations on start (Render, etc.).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/docker-start.sh ./docker-start.sh
RUN chmod +x ./docker-start.sh   && mkdir -p /app/data/tmp /app/data/storage && chown -R app:app /app/data
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Applies pending migrations (RUN_MIGRATIONS=true by default), then starts the bot.
CMD ["./docker-start.sh"]
