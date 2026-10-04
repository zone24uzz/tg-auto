import type { UserMode } from '../generated/prisma/client.js';
import type { Settings } from '../settings/schema.js';

export interface RuleRecord {
  matchType: 'USER_ID' | 'USERNAME' | 'CHAT_ID' | 'TAG';
  matchValue: string;
  mode: UserMode;
}

export interface SenderFacts {
  telegramUserId: bigint;
  username?: string | null;
  chatId: bigint;
  tags: string[];
  /** The owner has never written in this chat (seen via business messages). */
  isNewChat: boolean;
  /** Sender is in the owner's contacts (known in userbot mode). */
  isContact?: boolean;
}

export type RuleAction =
  /** Generate an AI reply (subject to classification). */
  | 'AUTO'
  /** Do not reply automatically; owner handles it. */
  | 'MANUAL'
  /** Do not reply; optionally notify the owner immediately. */
  | 'VIP'
  /** Store, but never reply or notify. */
  | 'IGNORE'
  /** Never reply. Stored only for audit/history. */
  | 'BLOCK';

export interface RuleDecision {
  action: RuleAction;
  /** The explicit rule that matched (if any). */
  matched?: RuleRecord;
  /** Short machine-readable reason, stored in messages.statusReason. */
  reason: string;
}

/** Specificity order: user id > chat id > username > tag. */
const PRIORITY: Record<RuleRecord['matchType'], number> = { USER_ID: 4, CHAT_ID: 3, USERNAME: 2, TAG: 1 };
/** For equally specific tag rules the most restrictive wins. */
const RESTRICTIVENESS: Record<UserMode, number> = { BLOCK: 5, IGNORE: 4, VIP: 3, MANUAL: 2, AUTO: 1 };

export function normalizeUsername(username: string | null | undefined): string | undefined {
  if (!username) return undefined;
  const u = username.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,32}$/.test(u) ? u : undefined;
}

export function normalizeTag(tag: string): string | undefined {
  const t = tag.trim().toLowerCase().replace(/^#/, '');
  return /^[\p{L}\p{N}_-]{1,32}$/u.test(t) ? t : undefined;
}

/** Most specific explicit rule for the sender, if any. */
export function findMatchingRule(rules: RuleRecord[], sender: SenderFacts): RuleRecord | undefined {
  const userId = sender.telegramUserId.toString();
  const chatId = sender.chatId.toString();
  const username = normalizeUsername(sender.username);
  const tags = new Set(sender.tags.map((t) => normalizeTag(t)).filter((t): t is string => !!t));

  const candidates = rules.filter((r) => {
    switch (r.matchType) {
      case 'USER_ID':
        return r.matchValue === userId;
      case 'CHAT_ID':
        return r.matchValue === chatId;
      case 'USERNAME':
        return username !== undefined && r.matchValue === username;
      case 'TAG':
        return tags.has(r.matchValue);
      default:
        return false;
    }
  });
  candidates.sort(
    (a, b) => PRIORITY[b.matchType] - PRIORITY[a.matchType] || RESTRICTIVENESS[b.mode] - RESTRICTIVENESS[a.mode],
  );
  return candidates[0];
}

/**
 * Pure decision: may the assistant auto-reply to this sender?
 * Global on/off and pause are evaluated by the caller (they also decide logging).
 */
export function decideRule(settings: Pick<Settings, 'replyMode' | 'unknownUserMode'>, rules: RuleRecord[], sender: SenderFacts): RuleDecision {
  const matched = findMatchingRule(rules, sender);

  // Hard stops always win, whatever the reply mode.
  if (matched?.mode === 'BLOCK') return { action: 'BLOCK', matched, reason: 'rule:block' };
  if (matched?.mode === 'IGNORE') return { action: 'IGNORE', matched, reason: 'rule:ignore' };
  if (matched?.mode === 'VIP') return { action: 'VIP', matched, reason: 'rule:vip' };
  if (matched?.mode === 'MANUAL') return { action: 'MANUAL', matched, reason: 'rule:manual' };

  const explicitAuto = matched?.mode === 'AUTO';

  switch (settings.replyMode) {
    case 'ALL_ALLOWED':
      return { action: 'AUTO', matched, reason: explicitAuto ? 'rule:auto' : 'mode:all' };
    case 'ALLOWLIST_ONLY':
      return explicitAuto
        ? { action: 'AUTO', matched, reason: 'rule:auto' }
        : { action: 'MANUAL', reason: 'mode:allowlist_only' };
    case 'NEW_CHATS_ONLY':
      if (explicitAuto) return { action: 'AUTO', matched, reason: 'rule:auto' };
      return sender.isNewChat ? { action: 'AUTO', reason: 'mode:new_chat' } : { action: 'MANUAL', reason: 'mode:existing_chat' };
    case 'NON_CONTACTS_ONLY': {
      // The Bot API does not expose the owner's contact list; users tagged "contact" count as contacts.
      if (explicitAuto) return { action: 'AUTO', matched, reason: 'rule:auto' };
      const isContact = sender.isContact === true || sender.tags.some((t) => normalizeTag(t) === 'contact');
      return isContact ? { action: 'MANUAL', reason: 'mode:contact' } : { action: 'AUTO', reason: 'mode:non_contact' };
    }
    case 'CUSTOM':
    default: {
      if (explicitAuto) return { action: 'AUTO', matched, reason: 'rule:auto' };
      const mode = settings.unknownUserMode;
      if (mode === 'IGNORE') return { action: 'IGNORE', reason: 'default:ignore' };
      if (mode === 'MANUAL') return { action: 'MANUAL', reason: 'default:manual' };
      return { action: 'AUTO', reason: 'default:auto' };
    }
  }
}
