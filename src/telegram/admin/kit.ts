import type { Context } from 'grammy';
import { PromptValidationError } from '../../conversations/prompt.service.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { RuleValidationError } from '../../rules/rules.service.js';
import type { SettingKey, Settings } from '../../settings/schema.js';
import { SettingValidationError } from '../../settings/settings.service.js';
import type { AdminDeps } from './deps.js';
import { requireAdmin } from './guard.js';
import type { AdminRouter } from './router.js';
import type { AdminStateStore, InputPayload } from './state.js';
import { CANCEL, Kb, btn, show } from './ui.js';

const log = childLogger('admin-ui');

/** Shared by every admin view module. */
export interface AdminKit {
  deps: AdminDeps;
  router: AdminRouter;
  states: AdminStateStore;
}

/** Expected, user-facing input problem (message is plain Uzbek text). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Re-checks the admin and returns their id (for audit). */
export function adminIdOf(kit: AdminKit, ctx: Context): bigint {
  return requireAdmin(ctx, kit.deps.adminTelegramUserId);
}

/** Validated, audited settings write with a dynamic key (SettingsService validates the value). */
export async function setSetting(kit: AdminKit, ctx: Context, key: SettingKey, value: unknown): Promise<void> {
  const adminId = adminIdOf(kit, ctx);
  await kit.deps.settings.set(key, value as Settings[SettingKey], adminId);
}

/**
 * Starts a pending text input: the admin's next text message goes to the input handler `state`.
 * `payload.back` (callback data) is where "❌ Bekor qilish" returns to.
 */
export async function ask(
  kit: AdminKit,
  ctx: Context,
  state: string,
  payload: InputPayload,
  html: string,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  const adminId = adminIdOf(kit, ctx);
  await kit.states.set(adminId, state, payload);
  await show(
    ctx,
    { text: `${html}\n\n<i>Bekor qilish: /cancel</i>`, keyboard: new Kb().row(btn('❌ Bekor qilish', CANCEL)).build() },
    opts,
  );
}

const RULE_ERRORS: Record<string, string> = {
  'ID must be numeric': 'ID faqat raqamlardan iborat bo‘lishi kerak.',
  'invalid username': 'Username noto‘g‘ri (3–32 belgi: harf, raqam, _).',
  'invalid tag': 'Teg noto‘g‘ri (1–32 belgi: harf, raqam, _ yoki -).',
  'unknown rule type': 'Noma’lum qoida turi.',
};

/** Plain-text friendly message for expected validation errors; null for unexpected ones. */
export function validationMessage(error: unknown): string | null {
  if (error instanceof SettingValidationError) return `Noto‘g‘ri qiymat: ${error.message.slice(0, 150)}`;
  if (error instanceof RuleValidationError) return RULE_ERRORS[error.message] ?? 'Noto‘g‘ri qiymat.';
  if (error instanceof PromptValidationError) return error.message;
  if (error instanceof InputError) return error.message;
  return null;
}

/** Logs an unexpected admin-side failure without message contents. */
export function logFailure(kit: AdminKit, where: string, error: unknown): void {
  const desc = describeError(error, 300);
  log.error({ where, error: desc }, 'admin action failed');
  try {
    kit.deps.events.error('admin-ui', `${where}: ${desc}`).catch(() => undefined);
  } catch {
    // the event log is best-effort
  }
}
