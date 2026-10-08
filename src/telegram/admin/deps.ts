import type { ProviderRegistry } from '../../ai/registry.js';
import type { AssistantPort } from '../../assistant/assistant.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { PromptService } from '../../conversations/prompt.service.js';
import type { Db } from '../../database/client.js';
import type { EventLog } from '../../logging/events.js';
import type { HistoryService } from '../../messages/history.service.js';
import type { OwnerAttentionService } from '../../owner-attention/attention.service.js';
import type { PrivacyService } from '../../privacy/privacy.service.js';
import type { PgQueue } from '../../queues/pg-queue.js';
import type { ReplyPipeline } from '../../responder/pipeline.js';
import type { CleanupService } from '../../retention/cleanup.service.js';
import type { RulesService } from '../../rules/rules.service.js';
import type { SettingsService } from '../../settings/settings.service.js';
import type { StatsService } from '../../statistics/stats.service.js';
import type { UsageService } from '../../statistics/usage.service.js';
import type { UsersService } from '../../users/users.service.js';
import type { ConnectionService } from '../main/connection.service.js';

/** Everything the admin bot UI needs. Built in src/app/container.ts. */
export interface AdminDeps {
  db: Db;
  /** The only Telegram user allowed to use the admin bot (ADMIN_TELEGRAM_USER_ID). */
  adminTelegramUserId: bigint;
  timezone: string;
  /** Raw message content encryption at rest is active (DATA_ENCRYPTION_KEY set). */
  encryptionEnabled: boolean;
  settings: SettingsService;
  rules: RulesService;
  users: UsersService;
  prompts: PromptService;
  attention: OwnerAttentionService;
  history: HistoryService;
  stats: StatsService;
  usage: UsageService;
  audit: AuditService;
  events: EventLog;
  privacy: PrivacyService;
  registry: ProviderRegistry;
  pipeline: ReplyPipeline;
  queue: PgQueue;
  connections: ConnectionService;
  cleanup: CleanupService;
  /** Owner's personal assistant (free-text commands, /tasks). Optional: absent → plain hint. */
  assistant?: AssistantPort;
}
