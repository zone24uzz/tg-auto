import type { Context, NextFunction } from 'grammy';
import { escapeHtml } from '../common/html.js';
import { parseCb } from './callback-data.js';
import { NotAdminError } from './guard.js';
import { adminIdOf, logFailure, validationMessage, type AdminKit } from './kit.js';
import type { PendingInput } from './state.js';
import { CANCEL, Kb, NOP, ack, btn, setNotice, type Toast } from './ui.js';
import { runAssistantText } from './views/assistant.js';
import { applyPause, pauseTarget, resumeAll, showAutoReply } from './views/auto-reply.js';
import { showHelp, showMainMenu, showStatus } from './views/main.js';

export const COMMANDS = ['start', 'menu', 'status', 'pause', 'resume', 'privacy', 'help', 'cancel', 'tasks'] as const;
type Command = (typeof COMMANDS)[number];

/** Routes that must not clear a pending text input when pressed. */
const KEEP_INPUT = new Set<string>([NOP, CANCEL]);

const MENU_KB = () => new Kb().row(btn('🏠 Menyu', 'm')).build();

export function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([A-Za-z_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() };
}

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

function errorToast(kit: AdminKit, error: unknown, where: string): Toast {
  if (error instanceof NotAdminError) return undefined;
  const msg = validationMessage(error);
  if (msg) return { text: `❌ ${msg}`, alert: true };
  logFailure(kit, where, error);
  return { text: '❌ Xatolik yuz berdi. 📜 Logs bo‘limini tekshiring.', alert: true };
}

/** Every callback: re-verify admin, drop stale pending input, run the route, answer exactly once. */
export async function handleCallback(kit: AdminKit, ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ack(ctx);
    return;
  }
  const { route, args } = parseCb(data);
  let toast: Toast;
  try {
    const adminId = adminIdOf(kit, ctx);
    const handler = kit.router.findAction(route);
    if (!handler) {
      toast = 'Bu tugma eskirgan. /menu';
    } else {
      if (!KEEP_INPUT.has(route)) await kit.states.clear(adminId);
      toast = await handler(ctx, args);
    }
  } catch (error) {
    toast = errorToast(kit, error, `callback ${route}`);
  }
  await ack(ctx, toast);
}

async function runCommand(kit: AdminKit, ctx: Context, name: Command, arg: string, adminId: bigint): Promise<void> {
  // Any command abandons a pending text input, so a later message is never mistaken for
  // (say) a manual reply to a customer typed minutes ago.
  if (name !== 'cancel') await kit.states.clear(adminId);
  switch (name) {
    case 'start':
    case 'menu':
      await showMainMenu(kit, ctx);
      return;
    case 'status':
      await showStatus(kit, ctx);
      return;
    case 'pause': {
      if (!arg) {
        await showAutoReply(kit, ctx);
        return;
      }
      const until = /^\d{1,4}$/.test(arg) && Number(arg) > 0 ? pauseTarget(arg, new Date(), kit.deps.timezone) : undefined;
      if (!until) {
        await ctx.reply('ℹ️ Foydalanish: <code>/pause</code> yoki <code>/pause 30</code> (1–1440 daqiqa).', { parse_mode: 'HTML' });
        return;
      }
      setNotice(ctx, await applyPause(kit, ctx, until));
      await showAutoReply(kit, ctx);
      return;
    }
    case 'resume':
      await resumeAll(kit, ctx);
      return;
    case 'privacy':
      await kit.router.go(ctx, 'pv');
      return;
    case 'help':
      await showHelp(kit, ctx);
      return;
    case 'tasks':
      await kit.router.go(ctx, 'as|list');
      return;
    case 'cancel': {
      const had = await kit.states.clear(adminId);
      await ctx.reply(had ? '❎ Bekor qilindi.' : 'ℹ️ Bekor qilinadigan narsa yo‘q.', { reply_markup: MENU_KB() });
      return;
    }
  }
}

async function runInput(kit: AdminKit, ctx: Context, pending: PendingInput, adminId: bigint): Promise<void> {
  const text = ctx.message?.text;
  if (text === undefined) {
    await ctx.reply('✍️ Iltimos, matn ko‘rinishida yuboring (bekor qilish: /cancel).');
    return;
  }
  const handler = kit.router.findInput(pending.state);
  await kit.states.clear(adminId);
  if (!handler) {
    await ctx.reply('ℹ️ Bu so‘rov eskirgan.', { reply_markup: MENU_KB() });
    return;
  }
  try {
    const result = await handler(ctx, text, pending.payload);
    if (result === 'retry') await kit.states.set(adminId, pending.state, pending.payload);
  } catch (error) {
    const msg = validationMessage(error);
    if (!msg) throw error;
    // Expected validation problem: keep waiting so the admin can simply resend.
    await kit.states.set(adminId, pending.state, pending.payload);
    await ctx.reply(`❌ ${escapeHtml(msg)}\n\nQaytadan yuboring yoki /cancel.`, {
      parse_mode: 'HTML',
      reply_markup: new Kb().row(btn('❌ Bekor qilish', CANCEL)).build(),
    });
  }
}

/** Admin messages: commands first, then a pending text input, otherwise a short hint. */
export async function handleMessage(kit: AdminKit, ctx: Context, next: NextFunction): Promise<void> {
  if (!ctx.message) return next();
  try {
    const adminId = adminIdOf(kit, ctx);
    const text = ctx.message.text;
    const command = text?.startsWith('/') ? parseCommand(text) : null;
    if (command && isCommand(command.name)) {
      await runCommand(kit, ctx, command.name, command.arg, adminId);
      return;
    }
    if (command) {
      // Unknown "/something" is never consumed as a pending answer (e.g. sent to a customer).
      await ctx.reply('ℹ️ Noma’lum buyruq. Buyruqlar ro‘yxati: /help', { reply_markup: MENU_KB() });
      return;
    }
    const pending = await kit.states.get(adminId);
    if (pending) {
      await runInput(kit, ctx, pending, adminId);
      return;
    }
    if (text === undefined) return next();
    if (kit.deps.assistant) {
      // No pending input: free text is a command for the owner's personal assistant.
      await runAssistantText(kit, ctx, text);
      return;
    }
    await ctx.reply('ℹ️ Hozir hech qanday matn kutilmayapti. Menyu: /menu · Yordam: /help', { reply_markup: MENU_KB() });
  } catch (error) {
    if (error instanceof NotAdminError) return;
    logFailure(kit, 'message', error);
    await ctx.reply('❌ Xatolik yuz berdi. Qaytadan urinib ko‘ring yoki 📜 Logs bo‘limini tekshiring.').catch(() => undefined);
  }
}
