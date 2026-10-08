import type { Bot } from 'grammy';
import { DefaultAiRouter } from '../ai/router/ai-router.js';
import { GlobalLimiter } from '../ai/router/global-limiter.js';
import { ProviderRegistry } from '../ai/registry.js';
import { OwnerAssistant } from '../assistant/assistant.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MessageClassifier } from '../classifiers/classifier.js';
import type { Env } from '../config/env.js';
import { PromptService } from '../conversations/prompt.service.js';
import { SummaryService } from '../conversations/summary.service.js';
import { createDb, type Db } from '../database/client.js';
import { EventLog } from '../logging/events.js';
import { registerSecrets } from '../logging/sanitize.js';
import { Ffmpeg } from '../media/ffmpeg.js';
import { MediaService } from '../media/media.service.js';
import { createStorage } from '../media/storage/index.js';
import { TelegramFileDownloader } from '../media/telegram-file.js';
import { RoutingFileDownloader } from './userbot-contract.js';
import { HistoryService } from '../messages/history.service.js';
import { MessageRepository } from '../messages/message.repository.js';
import { OwnerAttentionService } from '../owner-attention/attention.service.js';
import { PrivacyService } from '../privacy/privacy.service.js';
import { PgQueue } from '../queues/pg-queue.js';
import { ReplyPipeline } from '../responder/pipeline.js';
import { ReplySender } from '../responder/reply-sender.js';
import { TtsVoiceSynth } from '../responder/voice-synth.js';
import { CleanupService } from '../retention/cleanup.service.js';
import { RulesService } from '../rules/rules.service.js';
import { ContentCipher } from '../security/crypto.js';
import { buildDefaultSettings } from '../settings/schema.js';
import { SettingsService } from '../settings/settings.service.js';
import { StatsService } from '../statistics/stats.service.js';
import { UsageService } from '../statistics/usage.service.js';
import { AdminNotifier } from '../telegram/admin/notifier.js';
import { createBot } from '../telegram/main/bot.js';
import { BusinessHandlers } from '../telegram/main/business.handlers.js';
import { ConnectionService } from '../telegram/main/connection.service.js';
import { TelegramSender } from '../telegram/main/sender.js';
import { UsersService } from '../users/users.service.js';

export type Container = ReturnType<typeof buildContainer>;

/** Composition root: builds every service once. No I/O happens here except creating clients. */
export function buildContainer(env: Env) {
  registerSecrets([
    env.TELEGRAM_BOT_TOKEN,
    env.ADMIN_BOT_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.GEMINI_API_KEY,
    env.OPENAI_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.OPENAI_COMPAT_API_KEY,
    env.DATA_ENCRYPTION_KEY,
    env.S3_SECRET_ACCESS_KEY,
    env.S3_ACCESS_KEY_ID,
    passwordOf(env.DATABASE_URL),
  ]);

  const db: Db = createDb(env.DATABASE_URL);
  const cipher = new ContentCipher(env.DATA_ENCRYPTION_KEY);
  const audit = new AuditService(db);
  const events = new EventLog(db);
  const settings = new SettingsService(db, buildDefaultSettings(env), audit);

  const mainBot: Bot = createBot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT);
  const adminBot: Bot | null = env.ADMIN_BOT_TOKEN ? createBot(env.ADMIN_BOT_TOKEN, env.TELEGRAM_API_ROOT) : null;
  const notifier = new AdminNotifier((adminBot ?? mainBot).api, env.ADMIN_TELEGRAM_USER_ID, env.TIMEZONE, events);

  const repo = new MessageRepository(db, cipher);
  const rules = new RulesService(db, audit);
  const users = new UsersService(db, rules, audit);
  const queue = new PgQueue(db);
  const usage = new UsageService(db, env.TIMEZONE);

  const registry = ProviderRegistry.fromEnv(env);
  const ai = new DefaultAiRouter({
    registry,
    settings,
    usage,
    limiter: new GlobalLimiter(),
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  });
  const classifier = new MessageClassifier(ai);
  const prompts = new PromptService(db, audit, async () => (await settings.get()).ownerName);
  const summaries = new SummaryService(db, repo, ai, cipher);

  const sender = new TelegramSender(mainBot.api);
  const replies = new ReplySender(db, repo, sender, cipher, events);
  const attention = new OwnerAttentionService(db, cipher, notifier, audit);
  const connections = new ConnectionService(db, mainBot.api, env.ADMIN_TELEGRAM_USER_ID, notifier, events);

  const storage = createStorage(env);
  const ffmpeg = new Ffmpeg({ ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH, tmpDir: env.MEDIA_TMP_DIR });
  const downloader = new RoutingFileDownloader(
    new TelegramFileDownloader({ token: env.TELEGRAM_BOT_TOKEN, apiRoot: env.TELEGRAM_API_ROOT, tmpDir: env.MEDIA_TMP_DIR }),
  );
  const media = new MediaService({
    db,
    settings,
    ai,
    cipher,
    downloader,
    ffmpeg,
    storage,
    tmpDir: env.MEDIA_TMP_DIR,
    cloudBotApi: /^https:\/\/api\.telegram\.org\/?$/.test(env.TELEGRAM_API_ROOT),
  });
  const voice = new TtsVoiceSynth(ai, ffmpeg);

  const pipeline = new ReplyPipeline({
    db,
    repo,
    settings,
    rules,
    classifier,
    ai,
    media,
    prompts,
    summaries,
    sender,
    replies,
    attention,
    notifier,
    usage,
    queue,
    events,
    cipher,
    voice,
    timezone: env.TIMEZONE,
    adminTelegramUserId: env.ADMIN_TELEGRAM_USER_ID,
  });

  const history = new HistoryService(db, repo, cipher, env.TIMEZONE);
  const stats = new StatsService(db, env.TIMEZONE);
  const privacy = new PrivacyService(db, storage, audit, cipher.enabled);
  const cleanup = new CleanupService(db, queue, storage, env.MEDIA_TMP_DIR, events);
  const assistant = new OwnerAssistant({
    db,
    ai,
    cipher,
    notifier,
    queue,
    sendAsOwner: (chatId, text) => sender.sendAsOwner(chatId, text),
    timezone: env.TIMEZONE,
    events,
  });
  const business = new BusinessHandlers({
    db,
    repo,
    connections,
    settings,
    rules,
    queue,
    attention,
    notifier,
    events,
    logMessageContent: env.LOG_MESSAGE_CONTENT,
    assistant,
  });

  return {
    env,
    db,
    cipher,
    audit,
    events,
    settings,
    mainBot,
    adminBot,
    notifier,
    repo,
    rules,
    users,
    queue,
    usage,
    registry,
    ai,
    classifier,
    prompts,
    summaries,
    sender,
    replies,
    attention,
    connections,
    storage,
    ffmpeg,
    downloader,
    media,
    pipeline,
    history,
    stats,
    privacy,
    cleanup,
    business,
    assistant,
  };
}

function passwordOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
