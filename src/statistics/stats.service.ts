import type { Db } from '../database/client.js';
import { startOfDayInTz } from '../utils/time.js';

export interface PeriodStats {
  messages: number;
  aiReplies: number;
  manual: number;
  personal: number;
  ownerQueuePending: number;
  imagesAnalyzed: number;
  voiceAnalyzed: number;
  videosAnalyzed: number;
  videoNotesAnalyzed: number;
  documentsAnalyzed: number;
  edited: number;
  deleted: number;
  errors: number;
  avgAiLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface TopUser {
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  messages: number;
}

/** Aggregations for the admin "📊 Statistics" screen (never exposed publicly). */
export class StatsService {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
  ) {}

  todayStart(now = new Date()): Date {
    return startOfDayInTz(now, this.timezone);
  }

  weekStart(now = new Date()): Date {
    return new Date(this.todayStart(now).getTime() - 6 * 86_400_000);
  }

  async period(since: Date): Promise<PeriodStats> {
    const db = this.db;
    const mediaDone = (kind: 'PHOTO' | 'VOICE' | 'AUDIO' | 'VIDEO' | 'VIDEO_NOTE' | 'DOCUMENT') =>
      db.media.count({ where: { kind, status: 'DONE', processedAt: { gte: since } } });
    const [
      messages,
      aiReplies,
      manual,
      personal,
      ownerQueuePending,
      images,
      voice,
      audio,
      videos,
      videoNotes,
      documents,
      edited,
      deleted,
      errorEvents,
      failedReplies,
      latency,
      usage,
    ] = await Promise.all([
      db.message.count({ where: { direction: 'INCOMING', createdAt: { gte: since } } }),
      db.aiResponse.count({ where: { kind: { in: ['AUTO_REPLY', 'OWNER_APPROVED_AI'] }, status: 'SENT', createdAt: { gte: since } } }),
      db.message.count({ where: { direction: 'INCOMING', status: { in: ['MANUAL', 'OWNER_ATTENTION'] }, createdAt: { gte: since } } }),
      db.message.count({
        where: { direction: 'INCOMING', classification: { in: ['PERSONAL', 'SENSITIVE', 'REQUIRES_OWNER'] }, createdAt: { gte: since } },
      }),
      db.ownerAttention.count({ where: { status: 'PENDING' } }),
      mediaDone('PHOTO'),
      mediaDone('VOICE'),
      mediaDone('AUDIO'),
      mediaDone('VIDEO'),
      mediaDone('VIDEO_NOTE'),
      mediaDone('DOCUMENT'),
      db.message.count({ where: { editedAt: { gte: since }, versionCount: { gt: 1 } } }),
      db.message.count({ where: { deletedAt: { gte: since } } }),
      db.systemEvent.count({ where: { level: 'ERROR', createdAt: { gte: since } } }),
      db.aiResponse.count({ where: { status: { in: ['FAILED', 'UNCERTAIN'] }, createdAt: { gte: since } } }),
      db.aiResponse.aggregate({ _avg: { latencyMs: true }, where: { kind: 'AUTO_REPLY', createdAt: { gte: since } } }),
      db.usageStat.aggregate({ _sum: { inputTokens: true, outputTokens: true, costUsd: true }, where: { createdAt: { gte: since } } }),
    ]);
    return {
      messages,
      aiReplies,
      manual,
      personal,
      ownerQueuePending,
      imagesAnalyzed: images,
      voiceAnalyzed: voice + audio,
      videosAnalyzed: videos,
      videoNotesAnalyzed: videoNotes,
      documentsAnalyzed: documents,
      edited,
      deleted,
      errors: errorEvents + failedReplies,
      avgAiLatencyMs: latency._avg.latencyMs !== null ? Math.round(latency._avg.latencyMs) : null,
      inputTokens: usage._sum.inputTokens ?? 0,
      outputTokens: usage._sum.outputTokens ?? 0,
      estimatedCostUsd: Number(usage._sum.costUsd ?? 0),
    };
  }

  async topUsers(since: Date, limit = 5): Promise<TopUser[]> {
    const grouped = await this.db.message.groupBy({
      by: ['senderId'],
      where: { direction: 'INCOMING', createdAt: { gte: since }, senderId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { senderId: 'desc' } },
      take: limit,
    });
    const users = await this.db.telegramUser.findMany({
      where: { id: { in: grouped.map((g) => g.senderId).filter((v): v is number => v !== null) } },
    });
    return grouped
      .map((g) => {
        const u = users.find((x) => x.id === g.senderId);
        if (!u) return null;
        return { telegramUserId: u.telegramUserId, username: u.username, firstName: u.firstName, lastName: u.lastName, messages: g._count._all };
      })
      .filter((v): v is TopUser => v !== null);
  }

  async usageByModel(since: Date) {
    const rows = await this.db.usageStat.groupBy({
      by: ['provider', 'model'],
      where: { createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      costUsd: Number(r._sum.costUsd ?? 0),
    }));
  }
}
