import { pino, type Logger } from 'pino';
import { sanitizeText } from './sanitize.js';

const REDACT_PATHS = [
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-goog-api-key"]',
  'req.headers.authorization',
  'req.headers["x-telegram-bot-api-secret-token"]',
  '*.token',
  '*.apiKey',
  '*.password',
  '*.secret',
];

function createLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
  return pino({
    level,
    base: { service: 'tg-ai-autoresponder' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      // Final safety net: scrub secret-looking strings from the message and string args.
      logMethod(args, method) {
        const cleaned = args.map((a) => (typeof a === 'string' ? sanitizeText(a) : a));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (err: unknown) => {
        if (err instanceof Error) {
          return {
            type: err.name,
            message: sanitizeText(err.message),
            stack: err.stack ? sanitizeText(err.stack) : undefined,
          };
        }
        return { message: sanitizeText(String(err)) };
      },
    },
  });
}

export const logger: Logger = createLogger();

export function childLogger(module: string): Logger {
  return logger.child({ module });
}
