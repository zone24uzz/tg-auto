import type { Context } from 'grammy';
import { ASSISTANT_ROUTE, type AssistantReply, type AssistantStatus } from '../../../assistant/assistant.service.js';
import { currentTenantOrNull, type Lang } from '../../../tenancy/context.js';
import { clampMessage } from '../../common/html.js';
import { Kb, btn, show, type View } from '../ui.js';
import { logFailure, type AdminKit } from '../kit.js';

export function assistantView(reply: AssistantReply): View {
  const kb = new Kb();
  for (const row of reply.buttons ?? []) kb.row(...row.map((b) => btn(b.label, b.data)));
  kb.row(btn('🏠 Menyu', 'm'));
  return { text: reply.text, keyboard: kb.build() };
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS_LABEL: Record<Lang, Record<AssistantStatus, string>> = {
  uz: { thinking: '🤔 O‘ylayapman', searching: '🔎 Google’dan qidiryapman', database: '📇 Bazadan qidiryapman', writing: '✍️ Post yozyapman', calendar: '📅 Kalendarni ko‘ryapman', learning: '✍️ Uslubingizni o‘rganyapman' },
  ru: { thinking: '🤔 Думаю', searching: '🔎 Ищу в Google', database: '📇 Ищу в базе', writing: '✍️ Пишу пост', calendar: '📅 Смотрю календарь', learning: '✍️ Изучаю ваш стиль' },
  en: { thinking: '🤔 Thinking', searching: '🔎 Searching Google', database: '📇 Looking it up', writing: '✍️ Writing the post', calendar: '📅 Checking your calendar', learning: '✍️ Learning your style' },
};
/** Draft frames: Telegram animates changes of the same draft natively, so they can be frequent. */
const DRAFT_FRAME_MS = 700;
/** Fallback (editing a real message): Telegram allows about one edit per second in a chat. */
const EDIT_FRAME_MS = 1_100;
/** The native "typing…" indicator lasts ~5 s; refresh it before it fades. */
const TYPING_MS = 4_500;

/**
 * Live status while the assistant works. Preferred: a streamed message draft (sendMessageDraft) whose
 * changes Telegram animates smoothly, plus the native "typing…" indicator; the answer then arrives as a
 * normal message. Fallback (drafts unavailable): one real message edited about once a second — never
 * queuing edits, so a rate limit can never freeze it — and replaced by the answer.
 */
class LiveStatus {
  private status: AssistantStatus = 'thinking';
  private frame = 0;
  private mode: 'draft' | 'edit' | 'none' = 'draft';
  private readonly draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
  private messageId: number | null = null;
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private done = false;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: Context,
    private readonly lang: Lang,
  ) {}

  private render(): string {
    const dots = ['', '.', '..', '...'][this.frame % 4];
    return `${SPINNER[this.frame % SPINNER.length]} ${STATUS_LABEL[this.lang][this.status]}${dots}`;
  }

  private typing(): void {
    void this.ctx.replyWithChatAction('typing').catch(() => undefined);
  }

  async start(): Promise<void> {
    const chatId = this.ctx.chat?.id;
    if (chatId === undefined) return;
    this.typing();
    this.typingTimer = setInterval(() => this.typing(), TYPING_MS);
    this.typingTimer.unref?.();
    try {
      await this.ctx.api.sendMessageDraft(chatId, this.draftId, this.render());
    } catch {
      this.mode = 'edit';
      try {
        const sent = await this.ctx.reply(`<i>${this.render()}</i>`, { parse_mode: 'HTML' });
        this.messageId = sent.message_id;
      } catch {
        this.mode = 'none';
      }
    }
    if (this.mode === 'none') return;
    this.frameTimer = setInterval(() => void this.tick(), this.mode === 'draft' ? DRAFT_FRAME_MS : EDIT_FRAME_MS);
    this.frameTimer.unref?.();
  }

  set(status: AssistantStatus): void {
    if (status === this.status) return;
    this.status = status;
    void this.tick();
  }

  /** One frame; skipped (not queued) while the previous request is still running. */
  private async tick(): Promise<void> {
    const chatId = this.ctx.chat?.id;
    if (this.done || this.busy || chatId === undefined) return;
    this.busy = true;
    this.frame++;
    const text = this.render();
    const request =
      this.mode === 'draft'
        ? this.ctx.api.sendMessageDraft(chatId, this.draftId, text)
        : this.messageId !== null
          ? this.ctx.api.editMessageText(chatId, this.messageId, `<i>${text}</i>`, { parse_mode: 'HTML' })
          : Promise.resolve();
    this.inflight = request.catch(() => undefined).finally(() => {
      this.busy = false;
    });
    await this.inflight;
  }

  /** Stops the animation and shows the answer. */
  async finish(view: View): Promise<void> {
    this.done = true;
    if (this.frameTimer) clearInterval(this.frameTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    // A frame still on its way must not land after (and overwrite) the answer.
    await this.inflight;
    const chatId = this.ctx.chat?.id;
    if (this.mode === 'edit' && this.messageId !== null && chatId !== undefined) {
      try {
        await this.ctx.api.editMessageText(chatId, this.messageId, clampMessage(view.text), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: view.keyboard,
        });
        return;
      } catch {
        await this.ctx.api.deleteMessage(chatId, this.messageId).catch(() => undefined);
      }
    }
    // Draft mode: the answer is a normal message (it replaces the streamed preview).
    await show(this.ctx, view, { fresh: true });
  }
}

/** Free text from the owner (no pending input) → the personal assistant, with a live status. */
export async function runAssistantText(kit: AdminKit, ctx: Context, text: string): Promise<void> {
  const assistant = kit.deps.assistant;
  if (!assistant) return;
  const live = new LiveStatus(ctx, currentTenantOrNull()?.language ?? 'uz');
  await live.start();
  // AI calls can take tens of seconds: finish in the background so the webhook answers at once
  // (Telegram would otherwise time out and redeliver the same update). The tenant scope carries over.
  void (async () => {
    let reply: AssistantReply;
    try {
      reply = await assistant.handleText(text, (status) => live.set(status));
    } catch (error) {
      logFailure(kit, 'assistant', error);
      reply = { text: '❌ Xatolik yuz berdi. Qaytadan urinib ko‘ring yoki 📜 Logs bo‘limini tekshiring.' };
    }
    await live.finish(assistantView(reply)).catch(() => undefined);
  })();
}

/** `as|<verb>|…` buttons: list / delete / pick a person / confirm or cancel a message. */
export function registerAssistant(kit: AdminKit): void {
  kit.router.action(ASSISTANT_ROUTE, async (ctx, args) => {
    const assistant = kit.deps.assistant;
    if (!assistant) return { text: 'ℹ️ Assistent ulanmagan.', alert: true };
    // Buttons like "another variant" call the AI: answer the button now, update the message when done.
    void assistant
      .handleAction(args)
      .then((reply) => show(ctx, assistantView(reply)))
      .catch((error: unknown) => logFailure(kit, 'assistant action', error));
    return '⏳';
  });
}
