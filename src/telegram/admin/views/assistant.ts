import type { Context } from 'grammy';
import { ASSISTANT_ROUTE, type AssistantReply } from '../../../assistant/assistant.service.js';
import type { AdminKit } from '../kit.js';
import { Kb, btn, show, type View } from '../ui.js';

export function assistantView(reply: AssistantReply): View {
  const kb = new Kb();
  for (const row of reply.buttons ?? []) kb.row(...row.map((b) => btn(b.label, b.data)));
  kb.row(btn('🏠 Menyu', 'm'));
  return { text: reply.text, keyboard: kb.build() };
}

/** Free text from the owner (no pending input) → the personal assistant. */
export async function runAssistantText(kit: AdminKit, ctx: Context, text: string): Promise<void> {
  const assistant = kit.deps.assistant;
  if (!assistant) return;
  await ctx.replyWithChatAction('typing').catch(() => undefined);
  await show(ctx, assistantView(await assistant.handleText(text)), { fresh: true });
}

/** `as|<verb>|…` buttons: list / delete / pick a person / confirm or cancel a message. */
export function registerAssistant(kit: AdminKit): void {
  kit.router.action(ASSISTANT_ROUTE, async (ctx, args) => {
    const assistant = kit.deps.assistant;
    if (!assistant) return { text: 'ℹ️ Assistent ulanmagan.', alert: true };
    await show(ctx, assistantView(await assistant.handleAction(args)));
  });
}
