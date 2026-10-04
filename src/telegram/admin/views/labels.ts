import type { AttentionStatus, UserMode } from '../../../generated/prisma/client.js';

export const USER_MODES: readonly UserMode[] = ['AUTO', 'MANUAL', 'IGNORE', 'VIP', 'BLOCK'];

export const MODE_ICON: Record<UserMode, string> = {
  AUTO: '🤖',
  MANUAL: '👤',
  IGNORE: '🔕',
  VIP: '⭐',
  BLOCK: '⛔',
};

export function isUserMode(value: string): value is UserMode {
  return (USER_MODES as readonly string[]).includes(value);
}

export function modeLabel(mode: UserMode | null): string {
  return mode ? `${MODE_ICON[mode]} ${mode}` : '⚪ DEFAULT';
}

export const ATTENTION_STATUS: Record<AttentionStatus, string> = {
  PENDING: '⏳ Kutilmoqda',
  REPLIED: '✅ Siz javob berdingiz',
  AI_REPLIED: '🤖 AI javob berdi',
  IGNORED: '🚫 E’tiborsiz qoldirildi',
  RESOLVED_BY_OWNER: '✅ Telegram’da o‘zingiz javob berdingiz',
};

export function attentionStatusLabel(status: string): string {
  return (ATTENTION_STATUS as Record<string, string>)[status] ?? status;
}
