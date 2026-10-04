import type { Context } from 'grammy';
import type { Settings } from '../../../settings/schema.js';
import { formatDateTime, formatTime, localDateKey, nextLocalTime } from '../../../utils/time.js';
import { cb } from '../callback-data.js';
import { toggleBtn } from '../controls.js';
import { setSetting, type AdminKit } from '../kit.js';
import { Kb, btn, setNotice, show, yesNo, type View } from '../ui.js';

export function isPaused(s: Pick<Settings, 'pausedUntil'>, now: Date): boolean {
  return !!s.pausedUntil && new Date(s.pausedUntil).getTime() > now.getTime();
}

/** "HH:MM" today, "DD.MM HH:MM" otherwise. */
export function formatUntil(until: Date, now: Date, timezone: string): string {
  return localDateKey(until, timezone) === localDateKey(now, timezone)
    ? formatTime(until, timezone)
    : formatDateTime(until, timezone);
}

/** Main-menu status: 🟢 ON / 🟡 PAUSED until HH:MM / 🔴 OFF. */
export function statusLine(s: Pick<Settings, 'autoReplyEnabled' | 'pausedUntil'>, now: Date, timezone: string): string {
  if (!s.autoReplyEnabled) return '🔴 OFF';
  if (s.pausedUntil && isPaused(s, now)) return `🟡 PAUSED until ${formatUntil(new Date(s.pausedUntil), now, timezone)}`;
  return '🟢 ON';
}

export interface AutoReplyData {
  settings: Settings;
  now: Date;
  timezone: string;
}

export function buildAutoReply(d: AutoReplyData): View {
  const s = d.settings;
  const paused = isPaused(s, d.now);
  const lines = [
    `${s.autoReplyEnabled ? (paused ? '🟡' : '🟢') : '🔴'} <b>AUTO REPLY</b>`,
    '',
    `Holat: <b>${s.autoReplyEnabled ? 'ENABLED' : 'DISABLED'}</b>`,
  ];
  if (paused && s.pausedUntil) lines.push(`⏸ Pauza: <b>${formatUntil(new Date(s.pausedUntil), d.now, d.timezone)}</b> gacha`);
  lines.push(
    '',
    'Avtojavob o‘chiq yoki pauzada bo‘lganda:',
    `• Xabarlarni saqlash: ${yesNo(s.logWhenDisabled)}`,
    `• Menga bildirishnoma: ${yesNo(s.notifyWhenDisabled)}`,
  );
  const kb = new Kb()
    .row(s.autoReplyEnabled ? btn('🔴 Turn OFF', cb('sv', 'ae', 0)) : btn('🟢 Turn ON', cb('sv', 'ae', 1)))
    .row(btn('⏸ 15 daq', cb('ar.p', 15)), btn('⏸ 1 soat', cb('ar.p', 60)), btn('⏸ 3 soat', cb('ar.p', 180)))
    .row(btn('🌙 Ertagacha (08:00)', cb('ar.p', 'tm')), paused ? btn('▶️ Resume', cb('ar.p', 0)) : null)
    .row(toggleBtn('lw', s.logWhenDisabled, 'Saqlash'), toggleBtn('nw', s.notifyWhenDisabled, 'Bildirishnoma'))
    .back();
  return { text: lines.join('\n'), keyboard: kb.build() };
}

/** Pause target for a `ar.p` argument: minutes, "tm" (tomorrow 08:00 local) or 0 (resume → null). */
export function pauseTarget(arg: string, now: Date, timezone: string): Date | null | undefined {
  if (arg === 'tm') return nextLocalTime(now, timezone, 8);
  if (!/^\d{1,4}$/.test(arg)) return undefined;
  const minutes = Number(arg);
  if (minutes === 0) return null;
  if (minutes > 1440) return undefined;
  return new Date(now.getTime() + minutes * 60_000);
}

export async function showAutoReply(kit: AdminKit, ctx: Context, opts: { fresh?: boolean } = {}): Promise<void> {
  const settings = await kit.deps.settings.get();
  await show(ctx, buildAutoReply({ settings, now: new Date(), timezone: kit.deps.timezone }), opts);
}

/** Applies a pause (Date), or resumes (null). Returns a short status text. */
export async function applyPause(kit: AdminKit, ctx: Context, until: Date | null): Promise<string> {
  await setSetting(kit, ctx, 'pausedUntil', until ? until.toISOString() : null);
  return until ? `⏸ ${formatUntil(until, new Date(), kit.deps.timezone)} gacha pauza` : '▶️ Davom ettirildi';
}

/** /resume: clears the pause and turns auto reply on if it was off. */
export async function resumeAll(kit: AdminKit, ctx: Context): Promise<void> {
  const s = await kit.deps.settings.get();
  if (s.pausedUntil !== null) await setSetting(kit, ctx, 'pausedUntil', null);
  if (!s.autoReplyEnabled) await setSetting(kit, ctx, 'autoReplyEnabled', true);
  setNotice(ctx, '▶️ Avtojavob davom ettirildi.');
  await showAutoReply(kit, ctx);
}

export function registerAutoReply(kit: AdminKit): void {
  kit.router.action('ar', async (ctx) => {
    await showAutoReply(kit, ctx);
  });
  kit.router.action('ar.p', async (ctx, [arg = '']) => {
    const until = pauseTarget(arg, new Date(), kit.deps.timezone);
    if (until === undefined) return { text: 'Bu tugma eskirgan.', alert: true };
    const toast = await applyPause(kit, ctx, until);
    await showAutoReply(kit, ctx);
    return toast;
  });
}
