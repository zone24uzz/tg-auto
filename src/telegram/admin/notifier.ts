import { InlineKeyboard, type Api } from 'grammy';
import type { EventLog } from '../../logging/events.js';
import { childLogger } from '../../logging/logger.js';
import { describeError } from '../../logging/sanitize.js';
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
  POLICY_BLOCKED: 'AI javobi xavfsizlik filtridan o‘tmadi',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

/**
 * Sends owner-facing notifications through the admin bot (or the main bot in single-bot mode).
 * All untrusted content is HTML-escaped. Failures are logged, never thrown.
 */
export class AdminNotifier {
  constructor(
    private readonly api: Api,
    private readonly adminChatId: bigint,
    private readonly timezone: string,
    private readonly events?: EventLog,
  ) {}

  private async send(html: string, keyboard?: InlineKeyboard): Promise<number | undefined> {
    try {
      const sent = await this.api.sendMessage(Number(this.adminChatId), clampMessage(html), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      return sent.message_id;
    } catch (error) {
      const desc = describeError(error);
      log.warn({ error: desc }, 'admin notification failed (has the owner pressed /start in the admin bot?)');
      await this.events?.warn('admin-notifier', `notification failed: ${desc}`);
      return undefined;
    }
  }

  async text(html: string): Promise<number | undefined> {
    return this.send(html);
  }

  async ownerAttention(p: {
    attentionId: number;
    userLabel: string;
    text: string;
    reason: string;
    detail?: string;
    waitingMessageSent: boolean;
  }): Promise<number | undefined> {
    const kb = new InlineKeyboard()
      .text('💬 Javob yozish', cb(ROUTES.attentionReply, p.attentionId))
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
    return this.send(lines.join('\n'), kb);
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
