import type { Db } from '../database/client.js';
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

  async recent(limit = 20, offset = 0, level?: EventLevel) {
    return this.db.systemEvent.findMany({
      where: level ? { level } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
