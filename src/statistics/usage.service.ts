import type { Db } from '../database/client.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AiOperation, ProviderId } from '../ai/types.js';
import { childLogger } from '../logging/logger.js';
import { startOfDayInTz } from '../utils/time.js';

const log = childLogger('usage');

export interface UsageEntry {
  provider: ProviderId;
  model: string;
  operation: AiOperation;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  imageCount?: number;
  costUsd?: number;
  latencyMs?: number;
  success: boolean;
  messageId?: number;
}

/** Implemented by UsageService; the AI router depends only on this. */
export interface UsageRecorder {
  record(entry: UsageEntry): Promise<void>;
}

export class UsageService implements UsageRecorder {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
  ) {}

  async record(entry: UsageEntry): Promise<void> {
    try {
      await this.db.usageStat.create({
        data: {
          provider: entry.provider,
          model: entry.model,
          operation: entry.operation,
          inputTokens: entry.inputTokens ?? 0,
          outputTokens: entry.outputTokens ?? 0,
          audioSeconds: Math.round(entry.audioSeconds ?? 0),
          imageCount: entry.imageCount ?? 0,
          costUsd: new Prisma.Decimal((entry.costUsd ?? 0).toFixed(6)),
          latencyMs: entry.latencyMs ?? null,
          success: entry.success,
          messageId: entry.messageId ?? null,
        },
      });
    } catch (error) {
      log.error({ err: error }, 'failed to record usage');
    }
  }

  /** Estimated AI spend (USD) since local midnight in the configured timezone. */
  async costToday(now = new Date()): Promise<number> {
    const since = startOfDayInTz(now, this.timezone);
    const agg = await this.db.usageStat.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: since } } });
    return Number(agg._sum.costUsd ?? 0);
  }
}
