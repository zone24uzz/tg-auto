import type { Context } from 'grammy';
import { ASSISTANT_ROUTE, type AssistantReply, type AssistantStatus } from '../../../assistant/assistant.service.js';
import { currentTenantOrNull, type Lang } from '../../../tenancy/context.js';
import { clampMessage } from '../../common/html.js';
import type { AdminKit } from '../kit.js';
import { Kb, btn, show, type View } from '../ui.js';

export function assistantView(reply: AssistantReply): View {
  const kb = new Kb();
  for (const row of reply.buttons ?? []) kb.row(...row.map((b) => btn(b.label, b.data)));
  kb.row(btn('🏠 Menyu', 'm'));
  return { text: reply.text, keyboard: kb.build() };
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STATUS_LABEL: Record<Lang, Record<AssistantStatus, string>> = {
  uz: { thinking: '🤔 O‘ylayapman', searching: '🔎 Google’dan qidiryapman', database: '📇 Bazadan qidiryapman', writing: '✍️ Post yozyapman' },
  ru: { thinking: '🤔 Думаю', searching: '🔎 Ищу в Google', database: '📇 Ищу в базе', writing: '✍️ Пишу пост' },
  en: { thinking: '🤔 Thinking', searching: '🔎 Searching Google', database: '📇 Looking it up', writing: '✍️ Writing the post' },
};
/** Edits per status message (Telegram allows roughly one edit per second in a chat). */
const FRAME_MS = 1_500;

/**
 * A single message that shows what the assistant is doing right now (spinner + live status) and is
 * then replaced by the answer itself.
 */
class LiveStatus {
  private status: AssistantStatus = 'thinking';
  private frame = 0;
  private messageId: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private shown = '';
  private done = false;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: Context,
    private readonly lang: Lang,
  ) {}

  private render(): string {
    const dots = '.'.repeat((this.frame % 3) + 1);
    return `${SPINNER[this.frame % SPINNER.length]} <i>${STATUS_LABEL[this.lang][this.status]}${dots}</i>`;
  }

  async start(): Promise<void> {
    try {
      const sent = await this.ctx.reply(this.render(), { parse_mode: 'HTML' });
      this.messageId = sent.message_id;
      this.shown = this.render();
    } catch {
      return;
    }
    this.timer = setInterval(() => void this.tick(), FRAME_MS);
    this.timer.unref?.();
  }

  set(status: AssistantStatus): void {
    if (status === this.status) return;
    this.status = status;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.done || this.messageId === null || !this.ctx.chat) return;
    this.frame++;
    const text = this.render();
    if (text === this.shown) return;
    this.shown = text;
    const edit = this.ctx.api.editMessageText(this.ctx.chat.id, this.messageId, text, { parse_mode: 'HTML' }).catch(() => undefined);
    this.inflight = edit;
    await edit;
  }

  /** Stops the animation and turns the status message into the answer (or sends it as a new message). */
  async finish(view: View): Promise<void> {
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    // A frame edit still on its way must not land after (and overwrite) the answer.
    await this.inflight;
    if (this.messageId !== null && this.ctx.chat) {
      try {
        await this.ctx.api.editMessageText(this.ctx.chat.id, this.messageId, clampMessage(view.text), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: view.keyboard,
        });
        return;
      } catch {
        await this.ctx.api.deleteMessage(this.ctx.chat.id, this.messageId).catch(() => undefined);
      }
    }
    await show(this.ctx, view, { fresh: true });
  }
}

/** Free text from the owner (no pending input) → the personal assistant, with a live status. */
export async function runAssistantText(kit: AdminKit, ctx: Context, text: string): Promise<void> {
  const assistant = kit.deps.assistant;
  if (!assistant) return;
  const live = new LiveStatus(ctx, currentTenantOrNull()?.language ?? 'uz');
  await live.start();
  let reply: AssistantReply;
  try {
    reply = await assistant.handleText(text, (status) => live.set(status));
  } catch (error) {
    await live.finish(assistantView({ text: '❌ Xatolik yuz berdi. Qaytadan urinib ko‘ring.' }));
    throw error;
  }
  await live.finish(assistantView(reply));
}

/** `as|<verb>|…` buttons: list / delete / pick a person / confirm or cancel a message. */
export function registerAssistant(kit: AdminKit): void {
  kit.router.action(ASSISTANT_ROUTE, async (ctx, args) => {
    const assistant = kit.deps.assistant;
    if (!assistant) return { text: 'ℹ️ Assistent ulanmagan.', alert: true };
    await show(ctx, assistantView(await assistant.handleAction(args)));
  });
}
