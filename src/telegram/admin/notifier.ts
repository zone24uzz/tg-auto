import { InlineKeyboard, InputFile, type Api } from 'grammy';
import type { EventLog } from '../../logging/events.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
import { currentTenantOrNull } from '../../tenancy/context.js';
import { formatTime } from '../../utils/time.js';
import { clampMessage, quote } from '../common/html.js';
import { cb, ROUTES } from './callback-data.js';

const log = childLogger('admin-notifier');

export interface VersionView {
  version: number;
  text: string | null;
  caption?: string | null;
}

const REASON_LABELS: Record<string, string> = {
  PERSONAL: 'Shaxsiy savol',
  SENSITIVE: 'Nozik mavzu',
  REQUIRES_OWNER: 'Sizning qaroringiz kerak',
  UNKNOWN: 'Aniqlab bo‘lmadi',
  VIP: 'VIP foydalanuvchi',
  AI_FAILED: 'AI javob bera olmadi',
  COST_LIMIT: 'Kunlik AI limiti tugadi',
  MEDIA_FAILED: 'Mediani tahlil qilib bo‘lmadi',
  MEDIA_TOO_LARGE: 'Fayl juda katta',
  MANUAL: 'Qo‘lda javob beriladigan foydalanuvchi',
  STALE: 'Bot o‘chiq yoki uzilgan paytda kelgan xabar',
  POLICY_BLOCKED: 'AI javobi xavfsizlik filtridan o‘tmadi',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

/**
 * Sends owner-facing notifications through the admin bot (or the main bot in single-bot mode) to the
 * CURRENT tenant's owner; outside a tenant scope (system work) they go to the super-admin.
 * All untrusted content is HTML-escaped. Failures are logged, never thrown.
 */
export class AdminNotifier {
  constructor(
    private readonly api: Api,
    private readonly superAdminChatId: bigint,
    private readonly timezone: string,
    private readonly events?: EventLog,
  ) {}

  private get adminChatId(): bigint {
    return currentTenantOrNull()?.ownerTelegramUserId ?? this.superAdminChatId;
  }

  private async send(html: string, keyboard?: InlineKeyboard, opts: { silent?: boolean } = {}): Promise<number | undefined> {
    try {
      const sent = await this.api.sendMessage(Number(this.adminChatId), clampMessage(html), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(opts.silent ? { disable_notification: true } : {}),
      });
      return sent.message_id;
    } catch (error) {
      const desc = describeError(error);
      log.warn({ error: desc }, 'admin notification failed (has the owner pressed /start in the admin bot?)');
      await this.events?.warn('admin-notifier', `notification failed: ${desc}`);
      return undefined;
    }
  }

  /** `buttons`: rows of { label, callback data } (callback data must already be valid). */
  async text(html: string, opts: { silent?: boolean; buttons?: Array<Array<{ label: string; data: string }>> } = {}): Promise<number | undefined> {
    let keyboard: InlineKeyboard | undefined;
    if (opts.buttons && opts.buttons.length > 0) {
      keyboard = new InlineKeyboard();
      for (const row of opts.buttons) {
        for (const b of row) keyboard.text(b.label, b.data);
        keyboard.row();
      }
    }
    return this.send(html, keyboard, opts);
  }

  /** A file for the owner (e.g. the daily backup). Never throws; false when it could not be sent. */
  async document(file: Buffer, filename: string, caption: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    try {
      await this.api.sendDocument(Number(this.adminChatId), new InputFile(file, filename), {
        caption: clampMessage(caption).slice(0, 1000),
        parse_mode: 'HTML',
        ...(opts.silent ? { disable_notification: true } : {}),
      });
      return true;
    } catch (error) {
      const desc = describeError(error);
      log.warn({ error: desc }, 'admin document failed');
      await this.events?.warn('admin-notifier', `document failed: ${desc}`);
      return false;
    }
  }

  async ownerAttention(p: {
    attentionId: number;
    userLabel: string;
    text: string;
    reason: string;
    detail?: string;
    waitingMessageSent: boolean;
    /** Ready replies: one button each ("✉️ 1" sends the first one). */
    suggestions?: string[];
    silent?: boolean;
  }): Promise<number | undefined> {
    const kb = new InlineKeyboard();
    const drafts = (p.suggestions ?? []).slice(0, 3);
    if (drafts.length > 0) {
      drafts.forEach((_, i) => kb.text(`✉️ ${i + 1}`, cb(ROUTES.attentionDraft, p.attentionId, i)));
      kb.row();
    }
    kb.text('💬 Javob yozish', cb(ROUTES.attentionReply, p.attentionId))
      .text('🤖 AI javob bersin', cb(ROUTES.attentionAi, p.attentionId))
      .row()
      .text('🚫 E’tiborsiz', cb(ROUTES.attentionIgnore, p.attentionId))
      .text('👤 Doim qo‘lda', cb(ROUTES.attentionManual, p.attentionId));
    const lines = [
      '🔔 <b>Sizning javobingiz kerak</b>',
      '',
      `👤 Foydalanuvchi: ${quote(p.userLabel, 80)}`,
      '💬 Xabar:',
      `«${quote(p.text, 900)}»`,
      '',
      `Sabab: ${quote(reasonLabel(p.reason), 100)}${p.detail ? ` — <i>${quote(p.detail, 160)}</i>` : ''}`,
      p.waitingMessageSent ? '✉️ Kutish xabari yuborildi.' : '✉️ Foydalanuvchiga hech narsa yuborilmadi.',
    ];
    if (drafts.length > 0) {
      lines.push('', '📝 <b>Tayyor javoblar</b> — raqamni bossangiz, sizning nomingizdan yuboriladi:');
      drafts.forEach((d, i) => lines.push(`${i + 1}. ${quote(d, 300)}`));
    }
    return this.send(lines.join('\n'), kb, p.silent ? { silent: true } : {});
  }

  /** A message looked like a scam / phishing: it got no reply; offer to block the sender. */
  async scamWarning(p: { userLabel: string; text: string; reasons: string[]; messageId: number; senderTelegramUserId: bigint | null }): Promise<void> {
    const kb = new InlineKeyboard();
    if (p.senderTelegramUserId !== null) kb.text('🚫 Bloklash', cb(ROUTES.scamBlock, p.senderTelegramUserId));
    kb.text('🔎 Xabar', cb(ROUTES.messageOpen, p.messageId));
    await this.send(
      [
        '🛡 <b>Firibgarlik / spam ehtimoli</b>',
        '',
        `👤 ${quote(p.userLabel, 80)}`,
        `«${quote(p.text, 600)}»`,
        '',
        `Belgilar: ${quote(p.reasons.join(', '), 200)}`,
        'AI javob bermadi. Havolalarni ochmang, kod yoki karta ma’lumotlarini hech kimga bermang.',
      ].join('\n'),
      kb,
    );
  }

  async messageEdited(p: {
    userLabel: string;
    editedAt: Date;
    oldText: string | null;
    newText: string | null;
    versionNumber: number;
  }): Promise<void> {
    await this.send(
      [
        '✏️ <b>XABAR TAHRIRLANDI</b>',
        '',
        `👤 ${quote(p.userLabel, 80)}`,
        `🕐 Tahrirlandi: ${formatTime(p.editedAt, this.timezone)} (v${p.versionNumber})`,
        '',
        '<b>ESKI:</b>',
        `«${quote(p.oldText, 1200)}»`,
        '',
        '<b>YANGI:</b>',
        `«${quote(p.newText, 1200)}»`,
      ].join('\n'),
    );
  }

  async messageDeleted(p: {
    userLabel: string;
    writtenAt: Date;
    deletedAt: Date;
    versions: VersionView[];
    messageId: number;
  }): Promise<void> {
    const original = p.versions[0];
    const lines = [
      '🗑 <b>XABAR O‘CHIRILDI</b>',
      '',
      `👤 ${quote(p.userLabel, 80)}`,
      '',
      '<b>Asl matn:</b>',
      `«${quote(original?.text ?? original?.caption ?? null, 1200)}»`,
      '',
      `Yozilgan: ${formatTime(p.writtenAt, this.timezone)}`,
      `O‘chirilgan: ${formatTime(p.deletedAt, this.timezone)}`,
    ];
    if (p.versions.length > 1) {
      lines.push('', '<b>Versiyalar:</b>');
      for (const v of p.versions) lines.push(`${v.version}. «${quote(v.text ?? v.caption ?? null, 400)}»`);
    }
    await this.send(lines.join('\n'), new InlineKeyboard().text('🔎 Batafsil', cb(ROUTES.messageOpen, p.messageId)));
  }

  async deletedUnknown(p: { userLabel: string; count: number; deletedAt: Date }): Promise<void> {
    await this.send(
      [
        '🗑 <b>XABAR O‘CHIRILDI</b>',
        '',
        `👤 ${quote(p.userLabel, 80)}`,
        `${p.count} ta xabar o‘chirildi, lekin ular tizim ulanmasdan oldin yozilgan (yoki saqlanmagan) — asl matn mavjud emas.`,
        `O‘chirilgan: ${formatTime(p.deletedAt, this.timezone)}`,
      ].join('\n'),
    );
  }

  /** Marks an attention notification as resolved (edits it, drops the buttons). */
  async markAttentionResolved(messageId: number, statusLine: string): Promise<void> {
    try {
      await this.api.editMessageReplyMarkup(Number(this.adminChatId), messageId, { reply_markup: undefined });
      await this.api.sendMessage(Number(this.adminChatId), statusLine, {
        reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      });
    } catch (error) {
      log.debug({ error: describeError(error) }, 'could not update attention notification');
    }
  }
}
