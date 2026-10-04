import { GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { clampMessage, escapeHtml } from '../common/html.js';
import { ROUTES } from './callback-data.js';

/** A rendered admin screen. Text is HTML (parse_mode=HTML); untrusted parts must be escaped. */
export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

/** Callback answer: plain toast text, or an alert. */
export type Toast = string | { text: string; alert?: boolean } | undefined | void;

export type Btn = InlineKeyboardButton.CallbackButton;

/** No-op button (page counters, headings). */
export const NOP = 'nop';
/** Cancels the pending text input. */
export const CANCEL = 'cx';

export function btn(text: string, data: string): Btn {
  return InlineKeyboard.text(text, data);
}

/** Row-based keyboard builder that never emits empty rows. */
export class Kb {
  private readonly rows: Btn[][] = [];

  row(...buttons: Array<Btn | null | undefined | false>): this {
    const row = buttons.filter((b): b is Btn => !!b);
    if (row.length > 0) this.rows.push(row);
    return this;
  }

  grid(buttons: Btn[], perRow: number): this {
    for (let i = 0; i < buttons.length; i += perRow) this.row(...buttons.slice(i, i + perRow));
    return this;
  }

  pager(info: Pick<PageInfo, 'page' | 'pages'>, make: (page: number) => string): this {
    if (info.pages <= 1) return this;
    return this.row(
      info.page > 0 ? btn('◀️', make(info.page - 1)) : null,
      btn(`${info.page + 1}/${info.pages}`, NOP),
      info.page < info.pages - 1 ? btn('▶️', make(info.page + 1)) : null,
    );
  }

  /** Prev/next without a known total (logs). */
  simplePager(page: number, hasNext: boolean, make: (page: number) => string): this {
    if (page === 0 && !hasNext) return this;
    return this.row(page > 0 ? btn('◀️', make(page - 1)) : null, btn(`${page + 1}`, NOP), hasNext ? btn('▶️', make(page + 1)) : null);
  }

  /** "⬅️ Orqaga" (+ "🏠 Menyu" when the back target is not the menu itself). */
  back(data: string = ROUTES.menu): this {
    return data === ROUTES.menu
      ? this.row(btn('🏠 Menyu', ROUTES.menu))
      : this.row(btn('⬅️ Orqaga', data), btn('🏠 Menyu', ROUTES.menu));
  }

  build(): InlineKeyboard {
    return new InlineKeyboard(this.rows.map((r) => [...r]));
  }
}

// ───────────────────────────── pagination ─────────────────────────────

export interface PageInfo {
  /** 0-based, clamped into range. */
  page: number;
  pages: number;
  skip: number;
  take: number;
  total: number;
}

export function paginate(total: number, page: number, perPage: number): PageInfo {
  const size = Math.max(1, Math.floor(perPage));
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const pages = Math.max(1, Math.ceil(safeTotal / size));
  const requested = Number.isFinite(page) ? Math.floor(page) : 0;
  const p = Math.min(Math.max(0, requested), pages - 1);
  return { page: p, pages, skip: p * size, take: size, total: safeTotal };
}

/** Parses a page number from callback args (bad input → 0). */
export function pageArg(raw: string | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

/** Fetches a page; if the page vanished (items deleted meanwhile) falls back to the last one. */
export async function loadPage<T>(
  page: number,
  perPage: number,
  fetch: (take: number, skip: number) => Promise<{ items: T[]; total: number }>,
): Promise<{ items: T[]; info: PageInfo }> {
  const first = await fetch(perPage, page * perPage);
  const info = paginate(first.total, page, perPage);
  if (info.page === page) return { items: first.items, info };
  const again = await fetch(perPage, info.skip);
  return { items: again.items, info: paginate(again.total, info.page, perPage) };
}

// ───────────────────────────── rendering ─────────────────────────────

const notices = new WeakMap<Context, string>();
const answered = new WeakSet<Context>();

/** A line shown above the next screen rendered for this update (e.g. "✅ Saqlandi"). */
export function setNotice(ctx: Context, text: string): void {
  notices.set(ctx, text);
}

function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

function isBadRequest(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 400;
}

/**
 * Edits the callback's message in place, or sends a new message (commands, text inputs,
 * `fresh`, or when the old message cannot be edited). "Not modified" is ignored.
 */
export async function show(ctx: Context, view: View, opts: { fresh?: boolean } = {}): Promise<void> {
  const notice = notices.get(ctx);
  if (notice) notices.delete(ctx);
  const text = clampMessage(notice ? `${notice}\n\n${view.text}` : view.text);
  const extra = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: view.keyboard };
  if (ctx.callbackQuery?.message && !opts.fresh) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (error) {
      if (isNotModified(error)) return;
      if (!isBadRequest(error)) throw error;
    }
  }
  await ctx.reply(text, extra);
}

/** Answers the callback query once (later calls are no-ops). */
export async function ack(ctx: Context, toast?: Toast): Promise<void> {
  if (!ctx.callbackQuery || answered.has(ctx)) return;
  answered.add(ctx);
  const t = typeof toast === 'string' ? { text: toast } : typeof toast === 'object' ? toast : undefined;
  await ctx
    .answerCallbackQuery(t ? { text: t.text.slice(0, 190), show_alert: t.alert ?? false } : undefined)
    .catch(() => undefined);
}

// ───────────────────────────── formatting ─────────────────────────────

export function radio(selected: boolean, label: string): string {
  return `${selected ? '🔵' : '⚪'} ${label}`;
}

export function check(on: boolean, label: string): string {
  return `${on ? '✅' : '⬜'} ${label}`;
}

export function yesNo(on: boolean): string {
  return on ? '✅' : '❌';
}

export function usd(n: number): string {
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
}

export function num(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/**
 * Escapes untrusted text and truncates it so the *escaped* HTML is at most `max` chars
 * (escaping can grow text, and cutting HTML later would break parse_mode=HTML).
 */
export function fit(text: string | null | undefined, max: number): string {
  if (!text) return '<i>(bo‘sh)</i>';
  let n = Math.min(text.length, max);
  for (;;) {
    if (n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text.charAt(n - 1))) n -= 1;
    const cut = n < text.length;
    const html = `${escapeHtml(text.slice(0, n))}${cut ? '…' : ''}`;
    if (html.length <= max + 1 || n === 0) return html;
    n = Math.floor(n * 0.75);
  }
}

/** Single-line, length-limited text for button labels (Telegram shows them as plain text). */
export function label(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut on code points so emoji are never split into lone surrogates.
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** Parses a Telegram id from callback args / input; null when not numeric. */
export function bigId(raw: string | undefined): bigint | null {
  if (!raw || !/^-?\d{1,20}$/.test(raw)) return null;
  return BigInt(raw);
}

export function intId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 2_147_483_647 ? n : null;
}

/** Every callback_data in a keyboard (tests / sanity checks). */
export function callbackData(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard
    .flat()
    .map((b) => ('callback_data' in b ? b.callback_data : undefined))
    .filter((d): d is string => typeof d === 'string');
}
