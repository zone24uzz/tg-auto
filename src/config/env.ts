import { z } from 'zod';
import { loadDotEnv } from './dotenv.js';

/** Boolean env parser: accepts true/false/1/0/yes/no/on/off. */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `invalid boolean "${v}"` });
      return z.NEVER;
    });

/** Numeric env parser: empty → fallback; "abc" → NaN → rejected by z.number(). */
const toNumber = (fallback: number) => (v: string | undefined) => (v === undefined || v.trim() === '' ? fallback : Number(v));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.string().optional().transform(toNumber(fallback)).pipe(z.number().int().min(min).max(max));

const num = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.string().optional().transform(toNumber(fallback)).pipe(z.number().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const providerId = z.enum(['gemini', 'openai', 'anthropic', 'openai_compat']);
const optionalProvider = optionalString.pipe(providerId.optional());

const telegramToken = z
  .string()
  .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'must look like a Telegram bot token');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(8080, 1, 65535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TIMEZONE: z.string().default('Asia/Tashkent'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_UPDATE_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_URL: optionalString,
    TELEGRAM_WEBHOOK_SECRET: optionalString.pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 chars of A-Z a-z 0-9 _ -')
        .optional(),
    ),
    TELEGRAM_API_ROOT: z.string().default('https://api.telegram.org'),
    /** business = official Telegram Business bot (default); userbot = your own account via MTProto. */
    TELEGRAM_TRANSPORT: z.enum(['business', 'userbot']).default('business'),
    TELEGRAM_API_ID: optionalString.pipe(z.string().regex(/^\d{3,12}$/, 'must be the numeric api_id from my.telegram.org').optional()),
    TELEGRAM_API_HASH: optionalString.pipe(z.string().regex(/^[a-f0-9]{32}$/i, 'must be the 32-char api_hash from my.telegram.org').optional()),
    /** Optional pre-made GramJS StringSession (otherwise /login in the admin bot stores one encrypted in the DB). */
    TELEGRAM_SESSION: optionalString,
    /** MTProto port: 443 (default; works where plain port 80 is DPI-blocked) or 80. */
    MTPROTO_PORT: z.enum(['443', '80']).default('443'),
    /** Obfuscated MTProto transport (harder to block); disable only if a host has problems with it. */
    MTPROTO_OBFUSCATED: bool(true),
    ADMIN_BOT_TOKEN: optionalString.pipe(telegramToken.optional()),
    ADMIN_TELEGRAM_USER_ID: z
      .string()
      .regex(/^\d{1,20}$/, 'ADMIN_TELEGRAM_USER_ID must be a numeric Telegram user id')
      .transform((v) => BigInt(v)),
    OWNER_DISPLAY_NAME: z.string().min(1).max(64).default('Komron'),

    OPENAI_API_KEY: optionalString,
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
    GEMINI_API_KEY: optionalString,
    GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta'),
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com/v1'),
    OPENAI_COMPAT_BASE_URL: optionalString,
    OPENAI_COMPAT_API_KEY: optionalString,
    OPENAI_COMPAT_MODELS: optionalString,
    OPENAI_COMPAT_SUPPORTS_VISION: bool(false),
    OPENAI_COMPAT_SUPPORTS_REASONING: bool(false),
    OPENAI_COMPAT_SUPPORTS_TRANSCRIPTION: bool(false),

    DEFAULT_AI_PROVIDER: providerId.default('gemini'),
    DEFAULT_AI_MODEL: z.string().default('gemini-3.8-flash'),
    FALLBACK_AI_PROVIDER: optionalProvider,
    FALLBACK_AI_MODEL: optionalString,
    MEDIA_AI_PROVIDER: optionalProvider,
    MEDIA_AI_MODEL: optionalString,
    TRANSCRIPTION_AI_PROVIDER: optionalProvider,
    TRANSCRIPTION_AI_MODEL: optionalString,
    CLASSIFIER_AI_PROVIDER: optionalProvider,
    CLASSIFIER_AI_MODEL: optionalString,
    TTS_AI_PROVIDER: optionalProvider,
    TTS_AI_MODEL: optionalString,
    DEFAULT_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
    AI_REQUEST_TIMEOUT_MS: int(60_000, 1_000, 600_000),
    AI_PRICING_JSON: optionalString,

    AUTO_REPLY_ENABLED: bool(true),
    VOICE_RESPONSE_MODE: z.enum(['text', 'voice', 'adaptive']).default('text'),

    MESSAGE_RETENTION_DAYS: int(30, 1, 3650),
    MEDIA_RETENTION_DAYS: int(3, 0, 3650),
    AI_LOG_RETENTION_DAYS: int(30, 1, 3650),
    RETAIN_RAW_MEDIA: bool(false),

    MAX_MEDIA_SIZE_MB: num(20, 1, 2000),
    MAX_VIDEO_DURATION: int(180, 5, 3600),
    MAX_AUDIO_DURATION: int(600, 5, 7200),
    FRAME_SAMPLE_INTERVAL: num(5, 0.5, 600),
    MAX_FRAMES: int(6, 1, 30),
    MAX_DOCUMENT_SIZE_MB: num(10, 0.1, 100),
    MAX_DOCUMENT_CHARS: int(20_000, 500, 500_000),

    MAX_MESSAGES_PER_MINUTE: int(8, 1, 1000),
    MAX_AI_REQUESTS_PER_USER: int(30, 1, 100_000),
    GLOBAL_AI_REQUESTS_PER_MINUTE: int(60, 1, 100_000),
    MAX_DAILY_AI_COST: num(2, 0, 100_000),

    DATA_ENCRYPTION_KEY: optionalString,
    LOG_MESSAGE_CONTENT: bool(false),

    MEDIA_TMP_DIR: z.string().default('./data/tmp'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),

    WORKER_MODE: z.enum(['embedded', 'separate']).default('embedded'),
    WORKER_CONCURRENCY_TEXT: int(4, 1, 64),
    WORKER_CONCURRENCY_MEDIA: int(2, 1, 32),
  })
  .superRefine((env, ctx) => {
    if (env.TELEGRAM_UPDATE_MODE === 'webhook') {
      if (!env.TELEGRAM_WEBHOOK_URL)
        ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_URL'], message: 'required in webhook mode' });
      else if (!/^https:\/\//.test(env.TELEGRAM_WEBHOOK_URL))
        ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_URL'], message: 'must be an https:// URL' });
      if (!env.TELEGRAM_WEBHOOK_SECRET)
        ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'required in webhook mode' });
    }
    if (env.NODE_ENV === 'production' && !env.DATA_ENCRYPTION_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['DATA_ENCRYPTION_KEY'],
        message: 'required in production (32 random bytes, base64)',
      });
    if (env.DATA_ENCRYPTION_KEY && Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64').length !== 32)
      ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'must decode (base64) to exactly 32 bytes' });
    if (env.ADMIN_BOT_TOKEN && env.ADMIN_BOT_TOKEN === env.TELEGRAM_BOT_TOKEN)
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_BOT_TOKEN'],
        message: 'leave empty to reuse the main bot instead of repeating the same token',
      });
    if (env.TELEGRAM_TRANSPORT === 'userbot') {
      if (!env.TELEGRAM_API_ID) ctx.addIssue({ code: 'custom', path: ['TELEGRAM_API_ID'], message: 'required when TELEGRAM_TRANSPORT=userbot' });
      if (!env.TELEGRAM_API_HASH) ctx.addIssue({ code: 'custom', path: ['TELEGRAM_API_HASH'], message: 'required when TELEGRAM_TRANSPORT=userbot' });
      if (!env.DATA_ENCRYPTION_KEY && !env.TELEGRAM_SESSION)
        ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'required in userbot mode to store the login session encrypted' });
      if (env.WORKER_MODE !== 'embedded')
        ctx.addIssue({ code: 'custom', path: ['WORKER_MODE'], message: 'userbot mode needs WORKER_MODE=embedded (one MTProto connection sends the replies)' });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when STORAGE_DRIVER=s3' });
    }
  });

export type Env = z.infer<typeof envSchema>;
export type ProviderId = z.infer<typeof providerId>;
export const PROVIDER_IDS = providerId.options;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses env without ever echoing values (only variable names + reasons). */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Render exposes the public URL of a web service; use it as the webhook base when none is configured.
  const input = { ...source };
  if (!input.TELEGRAM_WEBHOOK_URL?.trim() && input.RENDER_EXTERNAL_URL) input.TELEGRAM_WEBHOOK_URL = input.RENDER_EXTERNAL_URL;
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  if (process.env.NODE_ENV !== 'test') {
    const overridden = loadDotEnv('.env');
    if (overridden.length > 0) console.warn(`.env overrides shell environment variables: ${overridden.join(', ')}`);
  }
  cached = parseEnv(process.env);
  return cached;
}

/** Test helper. */
export function setEnvForTests(env: Env | undefined): void {
  cached = env;
}
