import type { Db } from '../database/client.js';
import type { AuditAction } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { sanitizeText } from '../logging/sanitize.js';

const log = childLogger('audit');

/** Truncates and scrubs metadata so audit rows never carry secrets or huge blobs. */
function safeMetadata(meta: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/token|secret|password|api.?key/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === 'string') out[k] = sanitizeText(v).slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = sanitizeText(JSON.stringify(v, (_key, val: unknown) => (typeof val === 'bigint' ? val.toString() : val))).slice(0, 500);
  }
  return out;
}

export class AuditService {
  constructor(private readonly db: Db) {}

  async record(
    adminTelegramUserId: bigint,
    action: AuditAction,
    target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.auditLog.create({
        data: {
          adminTelegramUserId,
          action,
          target: target ? sanitizeText(target).slice(0, 200) : null,
          metadata: safeMetadata(metadata) ?? Prisma.JsonNull,
        },
      });
    } catch (error) {
      // Auditing must never break the admin action itself.
      log.error({ err: error, action }, 'failed to write audit log');
    }
  }

  async recent(limit = 20, offset = 0) {
    return this.db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit, skip: offset });
  }
}
