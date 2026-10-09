import type { Api } from 'grammy';
import { defaultFallbackReply, defaultMediaTooLargeReply, defaultOwnerRequiredReply, defaultPersonalReply, defaultUnsupportedMediaReply } from '../config/defaults.js';
import type { Db } from '../database/client.js';
import type { Tenant, TenantStatus } from '../generated/prisma/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import { T, type AiChoice } from '../onboarding/texts.js';
import type { SettingsService } from '../settings/settings.service.js';
import { langOf, type TenantService } from './tenant.service.js';

const log = childLogger('access');

/** Default models for a workspace that brings its own key. */
export const PROVIDER_DEFAULTS: Record<AiChoice, { aiModel: string; fallbackModel: string | null }> = {
  gemini: { aiModel: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash' },
  openai: { aiModel: 'gpt-5.5-mini', fallbackModel: 'gpt-5-mini' },
  anthropic: { aiModel: 'claude-sonnet-5-5', fallbackModel: 'claude-haiku-4-5-20251001' },
};

export type AccessGroup = 'pending' | 'active' | 'rejected';

/** Which rows each group of the super-admin's Access menu shows. */
export function groupWhere(group: AccessGroup): { status: { in: TenantStatus[] }; onboardingStep?: null } {
  if (group === 'pending') return { status: { in: ['PENDING'] }, onboardingStep: null };
  if (group === 'active') return { status: { in: ['ACTIVE'] } };
  return { status: { in: ['REJECTED', 'SUSPENDED'] } };
}

export type ApproveResult = 'approved' | 'already' | 'full' | 'not_found' | 'incomplete';

/** A request can be approved only after the owner finished setup with a verified API key. */
export function isReadyForApproval(tenant: Pick<Tenant, 'status' | 'onboardingStep' | 'aiApiKey'>): boolean {
  return tenant.status !== 'ACTIVE' && tenant.onboardingStep === null && !!tenant.aiApiKey;
}

export interface AccessDeps {
  db: Db;
  api: Pick<Api, 'sendMessage'>;
  tenants: TenantService;
  settings: SettingsService;
  superAdminId: bigint;
  /** Active workspaces besides the super-admin's (they connect through Telegram Business). */
  maxTenants: number;
  /** The bot's @username (without @), shown in the Telegram Business connection steps. */
  botUsername: () => string;
  /** After approval (e.g. publish the "/" menu for the new owner). */
  onApproved?: (tenant: Tenant) => Promise<void>;
  /** After rejection / revocation (e.g. stop the workspace's userbot). */
  onRevoked?: (tenant: Tenant) => Promise<void>;
}

/** Super-admin decisions about who may use the bot. */
export class AccessService {
  constructor(private readonly d: AccessDeps) {}

  async counts(): Promise<Record<AccessGroup, number>> {
    const [pending, active, rejected] = await Promise.all(
      (['pending', 'active', 'rejected'] as const).map((g) => this.d.db.tenant.count({ where: groupWhere(g) })),
    );
    return { pending: pending!, active: active!, rejected: rejected! };
  }

  async list(group: AccessGroup, take: number, skip: number): Promise<{ items: Tenant[]; total: number }> {
    const where = groupWhere(group);
    const [items, total] = await Promise.all([
      this.d.db.tenant.findMany({ where, orderBy: { updatedAt: 'desc' }, take, skip }),
      this.d.db.tenant.count({ where }),
    ]);
    return { items, total };
  }

  get(id: number): Promise<Tenant | null> {
    return this.d.db.tenant.findUnique({ where: { id } });
  }

  isSuperAdminTenant(tenant: Pick<Tenant, 'telegramUserId'>): boolean {
    return tenant.telegramUserId === this.d.superAdminId;
  }

  async approve(id: number): Promise<ApproveResult> {
    const tenant = await this.get(id);
    if (!tenant) return 'not_found';
    if (tenant.status === 'ACTIVE') return 'already';
    // A stale "approve" button (the owner restarted setup, or a rejected request whose key was wiped)
    // must not activate a workspace without a verified key.
    if (!isReadyForApproval(tenant)) return 'incomplete';
    const firstApproval = tenant.approvedAt === null;
    const others = await this.d.db.tenant.count({ where: { status: 'ACTIVE', telegramUserId: { not: this.d.superAdminId } } });
    if (others >= this.d.maxTenants) return 'full';

    const updated = await this.d.db.tenant.update({
      where: { id },
      data: { status: 'ACTIVE', approvedAt: new Date(), onboardingStep: null },
    });
    this.d.tenants.invalidate();
    // The workspace uses its own AI (always matching the verified key) and — on the first approval —
    // the owner's own name in every contact-facing text (never the super-admin's name).
    await this.d.tenants.run(updated, async () => {
      const ai = (updated.aiProvider ?? 'gemini') as AiChoice;
      const defaults = PROVIDER_DEFAULTS[ai] ?? PROVIDER_DEFAULTS.gemini;
      await this.d.settings.set('aiProvider', ai);
      await this.d.settings.set('aiModel', defaults.aiModel);
      await this.d.settings.set('fallbackProvider', defaults.fallbackModel ? ai : null);
      await this.d.settings.set('fallbackModel', defaults.fallbackModel);
      if (firstApproval) {
        const name = (updated.firstName ?? updated.username ?? 'Owner').slice(0, 60);
        await this.d.settings.set('ownerName', name);
        await this.d.settings.set('personalReplyText', defaultPersonalReply(name));
        await this.d.settings.set('ownerRequiredReplyText', defaultOwnerRequiredReply(name));
        await this.d.settings.set('fallbackReplyText', defaultFallbackReply(name));
        await this.d.settings.set('unsupportedMediaText', defaultUnsupportedMediaReply(name));
        await this.d.settings.set('mediaTooLargeText', defaultMediaTooLargeReply(name));
      }
    });
    await this.tell(updated, T[langOf(updated.language)].approved(this.d.botUsername()));
    await this.d.onApproved?.(updated).catch((error: unknown) => log.warn({ error: describeError(error) }, 'post-approval hook failed'));
    return 'approved';
  }

  /**
   * Lets a declined (or revoked) person set up again: back to PENDING at the language step; they
   * submit a new verified key and the request comes back to the super-admin.
   */
  async reopen(id: number): Promise<boolean> {
    const tenant = await this.get(id);
    if (!tenant || tenant.status === 'ACTIVE' || this.isSuperAdminTenant(tenant)) return false;
    const updated = await this.d.db.tenant.update({ where: { id }, data: { status: 'PENDING', onboardingStep: 'lang', aiApiKey: null, consentAt: null } });
    this.d.tenants.invalidate();
    await this.tell(updated, T[langOf(updated.language)].reopened);
    return true;
  }

  /** Rejects a request or revokes an active workspace. The stored AI key is wiped; history is kept. */
  async reject(id: number): Promise<boolean> {
    const tenant = await this.get(id);
    if (!tenant || this.isSuperAdminTenant(tenant)) return false;
    const wasActive = tenant.status === 'ACTIVE';
    const updated = await this.d.db.tenant.update({ where: { id }, data: { status: 'REJECTED', aiApiKey: null, onboardingStep: null } });
    this.d.tenants.invalidate();
    await this.tell(updated, T[langOf(updated.language)].rejected);
    if (wasActive) await this.d.onRevoked?.(updated).catch((error: unknown) => log.warn({ error: describeError(error) }, 'revocation hook failed'));
    return true;
  }

  private async tell(tenant: Tenant, html: string): Promise<void> {
    try {
      await this.d.api.sendMessage(Number(tenant.telegramUserId), html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (error) {
      log.warn({ error: describeError(error) }, 'could not notify the user about the access decision');
    }
  }
}
