import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { safeEqual } from '../../security/crypto.js';

const log = childLogger('http');
const MAX_BODY = 1024 * 1024;
/** /readyz hits the database at most once per this period, however often it is polled. */
export const READINESS_CACHE_MS = 5_000;

/**
 * Wraps a readiness check so it runs at most once per `ttlMs` (concurrent callers share one in-flight
 * check). A throwing check counts as "not ready" and is cached like any other result.
 */
export function cacheReadiness(
  check: () => Promise<boolean>,
  ttlMs: number = READINESS_CACHE_MS,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let cached: { value: boolean; at: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (!inflight) {
      inflight = check()
        .then(
          (value) => value === true,
          () => false,
        )
        .then((value) => {
          cached = { value, at: now() };
          inflight = null;
          return value;
        });
    }
    return inflight;
  };
}

export interface HttpServerOptions {
  port: number;
  /** Required for webhook routes; compared in constant time with X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret?: string;
  mainBot?: Bot;
  adminBot?: Bot;
  readiness: () => Promise<boolean>;
}

export const WEBHOOK_PATHS = { main: '/telegram/main', admin: '/telegram/admin' } as const;

function send(res: ServerResponse, status: number, body = ''): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isUpdate(value: unknown): value is Update {
  return typeof value === 'object' && value !== null && typeof (value as { update_id?: unknown }).update_id === 'number';
}

/**
 * Minimal HTTP server: health endpoints + Telegram webhooks with secret-token validation.
 * Responds 500 when processing throws so Telegram redelivers (idempotency makes that safe).
 */
export function startHttpServer(opts: HttpServerOptions): Server {
  const readiness = cacheReadiness(opts.readiness);
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/healthz') return send(res, 200, 'ok');
      if (req.method === 'GET' && url === '/readyz') return send(res, (await readiness()) ? 200 : 503, '');

      const bot = url === WEBHOOK_PATHS.main ? opts.mainBot : url === WEBHOOK_PATHS.admin ? opts.adminBot : undefined;
      if (req.method === 'POST' && bot) {
        const header = req.headers['x-telegram-bot-api-secret-token'];
        if (!opts.webhookSecret || typeof header !== 'string' || !safeEqual(header, opts.webhookSecret)) {
          return send(res, 401);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400);
        }
        if (!isUpdate(parsed)) return send(res, 400);
        try {
          await bot.handleUpdate(parsed);
          return send(res, 200);
        } catch (error) {
          log.error({ error: describeError(error) }, 'webhook update failed');
          return send(res, 500);
        }
      }
      return send(res, 404);
    } catch (error) {
      log.error({ error: describeError(error) }, 'http handler error');
      if (!res.headersSent) send(res, 500);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(opts.port, () => log.info({ port: opts.port }, 'http server listening'));
  return server;
}
