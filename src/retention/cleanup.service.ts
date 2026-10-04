import type { Db } from '../database/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { EventLog } from '../logging/events.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import { cleanupExpiredMedia, sweepTempDir } from '../media/cleanup.js';
import type { StorageDriver } from '../media/storage/storage.js';
import type { PgQueue } from '../queues/pg-queue.js';
import type { Settings } from '../settings/schema.js';

const log = childLogger('retention');
const DAY = 86_400_000;
const MESSAGE_BATCH = 500;
const USER_BATCH = 1000;

/**
 * Admin audit-log entries (who changed settings/rules, data deletions…) are a security record and
 * are kept for one year, independent of the message retention period, then deleted.
 */
export const AUDIT_LOG_RETENTION_DAYS = 365;

export interface CleanupReport {
  messages: number;
  orphanUsers: number;
  usageRows: number;
  events: number;
  processedUpdates: number;
  jobs: number;
  adminStates: number;
  /** Raw media objects deleted from storage (expired media + media of deleted messages). */
  mediaFiles: number;
  tempFiles: number;
  uncertainResponses: number;
  /** Rolling summaries deleted (chats whose messages were trimmed, or without messages). */
  summaries?: number;
  /** Audit-log rows older than AUDIT_LOG_RETENTION_DAYS. */
  auditLogs?: number;
  /** Disabled/unauthorized Telegram connections (without remaining messages) purged. */
  connections?: number;
  /** Expired messages kept: a pending owner-attention item covers them, or their media could not be deleted. */
  keptMessages?: number;
}

interface MessageTrimResult {
  deleted: number;
  kept: number;
  mediaFiles: number;
  chatIds: number[];
}

/** Applies the configured retention periods. Safe to run repeatedly. */
export class CleanupService {
  constructor(
    private readonly db: Db,
    private readonly queue: PgQueue,
    private readonly storage: StorageDriver,
    private readonly tmpDir: string,
    private readonly events: EventLog,
  ) {}

  async run(settings: Settings, now = new Date()): Promise<CleanupReport> {
    const msgCutoff = new Date(now.getTime() - settings.messageRetentionDays * DAY);
    const logCutoff = new Date(now.getTime() - settings.aiLogRetentionDays * DAY);
    const auditCutoff = new Date(now.getTime() - AUDIT_LOG_RETENTION_DAYS * DAY);

    // Raw media whose own retention expired (analysis results stay).
    const media = await cleanupExpiredMedia({ db: this.db, storage: this.storage, now });

    // Messages (cascades to versions, media rows, AI responses, owner-attention items).
    const trimmed = await this.deleteExpiredMessages(msgCutoff);

    // Summaries carry earlier content forward, so a chat whose messages were trimmed loses its summary
    // (it is rebuilt from the retained messages); chats without messages lose theirs too.
    const trimmedSummaries =
      trimmed.chatIds.length > 0
        ? await this.db.conversationSummary.deleteMany({ where: { chatId: { in: trimmed.chatIds } } })
        : { count: 0 };
    const emptySummaries = await this.db.conversationSummary.deleteMany({ where: { chat: { messages: { none: {} } } } });

    // Business connections that were disabled / not authorized for longer than the message retention and
    // whose chats have no messages left (cascades to those chats).
    const connections = await this.db.telegramConnection.deleteMany({
      where: {
        OR: [{ isEnabled: false }, { authorized: false }],
        updatedAt: { lt: msgCutoff },
        chats: { every: { messages: { none: {} } } },
      },
    });

    const orphanUsers = await this.deleteOrphanUsers(msgCutoff);

    const usageRows = await this.db.usageStat.deleteMany({ where: { createdAt: { lt: logCutoff } } });
    const events = await this.db.systemEvent.deleteMany({ where: { createdAt: { lt: logCutoff } } });
    const auditLogs = await this.db.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
    const processedUpdates = await this.db.processedUpdate.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - 3 * DAY) } } });
    const jobs = await this.queue.purgeFinished(new Date(now.getTime() - 7 * DAY));
    const adminStates = await this.db.adminState.deleteMany({ where: { expiresAt: { lt: now } } });

    // Replies whose delivery outcome is unknown for >10 min are marked UNCERTAIN (never resent).
    const uncertain = await this.db.aiResponse.updateMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
      data: { status: 'UNCERTAIN', error: 'delivery outcome unknown (process interrupted)' },
    });

    const temp = await sweepTempDir(this.tmpDir, 60 * 60_000);

    const report: CleanupReport = {
      messages: trimmed.deleted,
      orphanUsers,
      usageRows: usageRows.count,
      events: events.count,
      processedUpdates: processedUpdates.count,
      jobs,
      adminStates: adminStates.count,
      mediaFiles: media.deleted + trimmed.mediaFiles,
      tempFiles: temp.removed,
      uncertainResponses: uncertain.count,
      summaries: trimmedSummaries.count + emptySummaries.count,
      auditLogs: auditLogs.count,
      connections: connections.count,
      keptMessages: trimmed.kept,
    };
    log.info(report, 'retention cleanup finished');
    await this.events.info('retention', `cleanup: ${JSON.stringify(report)}`);
    return report;
  }

  /**
   * Deletes messages older than the cutoff, in batches. Messages covered by a PENDING owner-attention
   * item (the anchor and its whole burst) are kept until the owner handles them. Retained raw-media
   * objects are deleted from storage BEFORE their message (the media rows cascade with the message,
   * which would orphan the files); a message whose object cannot be deleted is kept for the next run.
   */
  private async deleteExpiredMessages(cutoff: Date): Promise<MessageTrimResult> {
    const pending = await this.db.ownerAttention.findMany({
      where: { status: 'PENDING' },
      select: { messageId: true, burstMessageIds: true },
    });
    const protectedIds = new Set<number>();
    for (const item of pending) {
      protectedIds.add(item.messageId);
      for (const id of item.burstMessageIds) protectedIds.add(id);
    }

    const chatIds = new Set<number>();
    let deleted = 0;
    let kept = 0;
    let mediaFiles = 0;
    let cursor = 0;
    for (;;) {
      const batch = await this.db.message.findMany({
        where: { createdAt: { lt: cutoff }, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: MESSAGE_BATCH,
        select: { id: true, chatId: true },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;

      const candidates = batch.filter((m) => !protectedIds.has(m.id));
      kept += batch.length - candidates.length;

      const blocked = new Set<number>();
      if (candidates.length > 0) {
        const files = await this.db.media.findMany({
          where: { messageId: { in: candidates.map((m) => m.id) }, storageKey: { not: null } },
          select: { id: true, messageId: true, storageKey: true },
        });
        for (const file of files) {
          if (!file.storageKey) continue;
          try {
            await this.storage.delete(file.storageKey);
            mediaFiles++;
          } catch (error) {
            blocked.add(file.messageId);
            log.warn({ err: describeError(error), mediaId: file.id }, 'could not delete media object; message kept');
          }
        }
      }

      const deletable = candidates.filter((m) => !blocked.has(m.id));
      kept += candidates.length - deletable.length;
      if (deletable.length > 0) {
        const result = await this.db.message.deleteMany({
          where: {
            id: { in: deletable.map((m) => m.id) },
            // Guard against an attention item that became pending while this run was going.
            OR: [{ attention: { is: null } }, { attention: { is: { status: { not: 'PENDING' } } } }],
          },
        });
        deleted += result.count;
        for (const m of deletable) chatIds.add(m.chatId);
      }
      if (batch.length < MESSAGE_BATCH) break;
    }
    return { deleted, kept, mediaFiles, chatIds: [...chatIds] };
  }

  /**
   * Deletes contact profiles that hold nothing the owner set up: no messages, inactive for longer than
   * the retention, no tags (TAG rules such as #family → MANUAL depend on them), no notes, not a
   * Telegram contact, and not referenced by a USER_ID or USERNAME rule. Deleting such a profile
   * would silently switch the person back to the default (auto-reply) mode.
   */
  private async deleteOrphanUsers(cutoff: Date): Promise<number> {
    const rules = await this.db.userRule.findMany({
      where: { matchType: { in: ['USER_ID', 'USERNAME'] } },
      select: { matchType: true, matchValue: true },
    });
    const ruleIds = new Set<bigint>();
    const ruleUsernames = new Set<string>();
    for (const rule of rules) {
      const value = rule.matchValue.trim();
      if (rule.matchType === 'USER_ID') {
        if (/^-?\d{1,20}$/.test(value)) ruleIds.add(BigInt(value));
      } else if (value) {
        ruleUsernames.add(value.replace(/^@/, '').toLowerCase());
      }
    }

    const orphanWhere: Prisma.TelegramUserWhereInput = {
      messages: { none: {} },
      isContact: false,
      tags: { isEmpty: true },
      AND: [
        { OR: [{ notes: null }, { notes: '' }] },
        { OR: [{ lastMessageAt: { lt: cutoff } }, { lastMessageAt: null, createdAt: { lt: cutoff } }] },
      ],
    };
    const candidates = await this.db.telegramUser.findMany({
      where: orphanWhere,
      select: { id: true, telegramUserId: true, username: true },
    });
    const ids = candidates
      .filter((u) => !ruleIds.has(u.telegramUserId) && !(u.username && ruleUsernames.has(u.username.toLowerCase())))
      .map((u) => u.id);

    let deleted = 0;
    for (let i = 0; i < ids.length; i += USER_BATCH) {
      // Conditions are re-checked so a profile that changed meanwhile is kept.
      const result = await this.db.telegramUser.deleteMany({ where: { id: { in: ids.slice(i, i + USER_BATCH) }, ...orphanWhere } });
      deleted += result.count;
    }
    return deleted;
  }
}
