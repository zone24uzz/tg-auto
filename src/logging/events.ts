import type { Db } from '../database/client.js';
import { currentTenantId, runAsSystem } from '../tenancy/context.js';
import type { EventLevel } from '../generated/prisma/client.js';
import { childLogger } from './logger.js';
import { sanitizeText } from './sanitize.js';

const log = childLogger('events');

/**
 * Small, sanitized operational log stored in the DB for the admin "📜 Logs" screen.
 * Never pass message content or secrets here — only ids and short descriptions.
 */
export class EventLog {
  constructor(private readonly db: Db) {}

  async record(level: EventLevel, source: string, message: string): Promise<void> {
    try {
      await this.db.systemEvent.create({
        data: { level, source: source.slice(0, 64), message: sanitizeText(message).slice(0, 1000) },
      });
    } catch (error) {
      log.error({ err: error }, 'failed to record system event');
    }
  }

  info(source: string, message: string) {
    return this.record('INFO', source, message);
  }

  warn(source: string, message: string) {
    return this.record('WARN', source, message);
  }

  error(source: string, message: string) {
    return this.record('ERROR', source, message);
  }

  /**
   * The current workspace's events; with `includeSystem` (super-admin) also system-wide events
   * (tenantId NULL), read in system scope with an explicit filter so other workspaces stay hidden.
   */
  async recent(limit = 20, offset = 0, level?: EventLevel, includeSystem = false) {
    if (includeSystem) {
      const tenantId = currentTenantId('events');
      return runAsSystem(() =>
        this.db.systemEvent.findMany({
          where: { ...(level ? { level } : {}), OR: [{ tenantId }, { tenantId: null }] },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      );
    }
    return this.db.systemEvent.findMany({
      where: level ? { level } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
