import type { AiRouter } from '../ai/router/types.js';
import type { Db } from '../database/client.js';
import { childLogger } from '../logging/logger.js';
import { describeError } from '../logging/sanitize.js';
import type { ContentCipher } from '../security/crypto.js';
import type { SettingsService } from '../settings/settings.service.js';
import { currentTenantOrNull } from '../tenancy/context.js';

const log = childLogger('style');

/** Fewer own messages than this say too little about how the owner writes. */
export const MIN_STYLE_MESSAGES = 20;
const SAMPLE_MESSAGES = 300;
const SAMPLE_CHARS = 12_000;
/** Automatic refresh interval (the owner can also ask: "uslubimni o'rgan"). */
export const STYLE_REFRESH_MS = 7 * 86_400_000;
const MAX_PROFILE = 1200;

export type LearnResult = { ok: true; profile: string; messages: number } | { ok: false; reason: 'too_few'; messages: number } | { ok: false; reason: 'ai_failed' };

/**
 * Learns how the owner writes from their own outgoing messages (never the contacts' messages) into a
 * short style description that the reply prompt imitates. Only the manner is kept — no facts, names
 * or other content from the messages.
 */
export class StyleService {
  /** Per workspace: no automatic attempt before this time (after too few messages / an AI failure). */
  private readonly nextTry = new Map<number, number>();

  constructor(
    private readonly d: { db: Db; ai: AiRouter; cipher: ContentCipher; settings: SettingsService; now?: () => Date },
  ) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  async learn(): Promise<LearnResult> {
    const rows = await this.d.db.message.findMany({
      where: { direction: 'OUTGOING_OWNER', deletedAt: null, type: 'TEXT' },
      orderBy: { id: 'desc' },
      take: SAMPLE_MESSAGES,
      select: { currentText: true },
    });
    const texts: string[] = [];
    let total = 0;
    for (const r of rows) {
      const t = this.d.cipher.decrypt(r.currentText)?.trim();
      if (!t || t.length < 2 || t.startsWith('/')) continue;
      if (total + t.length > SAMPLE_CHARS) break;
      texts.push(t.slice(0, 400));
      total += t.length;
    }
    if (texts.length < MIN_STYLE_MESSAGES) return { ok: false, reason: 'too_few', messages: texts.length };
    const settings = await this.d.settings.get();
    try {
      const routed = await this.d.ai.generateReply({
        system: [
          `Below are Telegram messages written by ${settings.ownerName} (one per line, newest first).`,
          `Describe ${settings.ownerName}'s writing style so another writer can reply exactly like them: language and script they use with whom (Uzbek Latin/Cyrillic, Russian, English, mixing), typical length, capital letters, punctuation, emoji and sticker-like habits, greetings and goodbyes, slang, filler words and phrases they repeat, how formal or warm they are, how they say yes / no / later.`,
          'Write 6–10 short bullet lines in English, max 120 words. Quote at most 5 very short typical phrases.',
          'Never include facts, names, places, numbers, plans, prices or any other content from the messages — only the manner of writing.',
        ].join('\n'),
        messages: [{ role: 'user', parts: [{ type: 'text', text: texts.join('\n') }] }],
        maxOutputTokens: 600,
        temperature: 0.2,
        timeoutMs: 60_000,
      });
      const profile = routed.result.text.trim().slice(0, MAX_PROFILE);
      if (!profile) return { ok: false, reason: 'ai_failed' };
      await this.d.settings.set('styleProfile', profile);
      await this.d.settings.set('styleLearnedAt', this.now().toISOString());
      return { ok: true, profile, messages: texts.length };
    } catch (error) {
      log.warn({ error: describeError(error) }, 'style learning failed');
      return { ok: false, reason: 'ai_failed' };
    }
  }

  /** Scheduler: refresh the profile weekly (first time as soon as there are enough messages). */
  async refreshIfDue(): Promise<void> {
    const s = await this.d.settings.get();
    if (!s.useStyleProfile) return;
    const last = s.styleLearnedAt ? new Date(s.styleLearnedAt).getTime() : 0;
    if (this.now().getTime() - last < STYLE_REFRESH_MS) return;
    const key = currentTenantOrNull()?.tenantId ?? 0;
    if (this.now().getTime() < (this.nextTry.get(key) ?? 0)) return;
    // A failed / too-early attempt waits a day before trying again.
    const result = await this.learn();
    if (!result.ok) this.nextTry.set(key, this.now().getTime() + 86_400_000);
  }
}
