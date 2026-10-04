import type { Context } from 'grammy';
import type { Settings } from '../../../settings/schema.js';
import { escapeHtml } from '../../common/html.js';
import { cb, parseCb, ROUTES } from '../callback-data.js';
import { adminIdOf, type AdminKit } from '../kit.js';
import { CANCEL, Kb, NOP, btn, setNotice, show, type View } from '../ui.js';
import { isPaused, statusLine } from './auto-reply.js';

export interface MainData {
  settings: Settings;
  pending: number;
  costToday: number;
  now: Date;
  timezone: string;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

export function costLine(cost: number, limit: number): string {
  return `💸 Today: ${money(cost)} / ${limit > 0 ? money(limit) : '∞'}`;
}

export function buildMainMenu(d: MainData): View {
  const s = d.settings;
  const text = [
    '🤖 <b>AUTO RESPONDER</b>',
    '',
    `Status: ${statusLine(s, d.now, d.timezone)}`,
    `🔔 Owner queue: ${d.pending}   ${costLine(d.costToday, s.maxDailyAiCostUsd)}`,
  ].join('\n');
  const autoLabel = !s.autoReplyEnabled ? '🔴 Auto Reply: OFF' : isPaused(s, d.now) ? '🟡 Auto Reply: PAUSED' : '🟢 Auto Reply: ON';
  const buttons = [
    btn(autoLabel, 'ar'),
    btn('👥 Reply Rules', 'rr'),
    btn('👤 Users', cb('us', 0)),
    btn('⭐ Allowlist', cb('ls', 'a', 0)),
    btn('🚫 Blocklist', cb('ls', 'b', 0)),
    btn('🔕 Ignore List', cb('ls', 'i', 0)),
    btn('🧠 AI Model', 'ai'),
    btn('⚙️ Reasoning Effort', 're'),
    btn('📝 System Prompt', 'pr'),
    btn('🎭 Response Style', 'st'),
    btn('📏 Response Length', 'ln'),
    btn('🔒 Personal Questions', 'pq'),
    btn('📷 Image Analysis', 'md.i'),
    btn('🎙 Voice Analysis', 'md.v'),
    btn('🎥 Video Analysis', 'md.vd'),
    btn('⭕ Video Note Analysis', 'md.n'),
    btn('📁 File Analysis', 'md.d'),
    btn(d.pending > 0 ? `🔔 Owner Attention (${d.pending})` : '🔔 Owner Attention', cb('oa.l', 0)),
    btn('💬 Message History', cb('h', 'all', 0)),
    btn('✏️ Edited Messages', cb('h', 'edited', 0)),
    btn('🗑 Deleted Messages', cb('h', 'deleted', 0)),
    btn('📊 Statistics', 'stt'),
    btn('⚙️ Advanced Settings', 'adv'),
    btn('📜 Logs', cb('lg', 0)),
    btn('🔐 Privacy', 'pv'),
  ];
  return { text, keyboard: new Kb().grid(buttons, 2).build() };
}

export interface StatusData extends MainData {
  connection: { isEnabled: boolean; canReply: boolean } | null;
}

export function buildStatus(d: StatusData): View {
  const s = d.settings;
  const conn = d.connection
    ? `${d.connection.isEnabled ? '🟢 ulangan' : '🔴 o‘chirilgan'}, javob berish: ${d.connection.canReply ? '✅' : '❌'}`
    : '⚪ ulanmagan';
  const text = [
    '📡 <b>HOLAT</b>',
    '',
    `Avtojavob: ${statusLine(s, d.now, d.timezone)}`,
    `🔔 Owner queue: ${d.pending}`,
    costLine(d.costToday, s.maxDailyAiCostUsd),
    `🧠 Model: <code>${escapeHtml(s.aiProvider)}</code> / <code>${escapeHtml(s.aiModel)}</code>`,
    `🔌 Telegram Business: ${conn}`,
  ].join('\n');
  return { text, keyboard: new Kb().row(btn('🏠 Menyu', ROUTES.menu), btn('🔄 Yangilash', 'sts')).build() };
}

export function buildHelp(ownerName: string): View {
  const text = [
    'ℹ️ <b>YORDAM</b>',
    '',
    `Bu bot — ${escapeHtml(ownerName)} uchun Telegram Business avtojavob boshqaruv paneli.`,
    '',
    '/menu — asosiy menyu',
    '/status — qisqa holat',
    '/pause — avtojavobni vaqtincha to‘xtatish (masalan: <code>/pause 30</code> — 30 daqiqa)',
    '/resume — avtojavobni davom ettirish',
    '/privacy — maxfiylik va ma’lumotlar',
    '/cancel — kutilayotgan matn kiritishni bekor qilish',
    '/help — shu yordam',
    '',
    'Tugmalar orqali sozlamalar shu xabarning o‘zida o‘zgaradi. Matn so‘ralganda keyingi xabaringiz javob sifatida qabul qilinadi (15 daqiqa ichida).',
  ].join('\n');
  return { text, keyboard: new Kb().back().build() };
}

async function loadMain(kit: AdminKit): Promise<MainData> {
  const [settings, pending, costToday] = await Promise.all([
    kit.deps.settings.get(),
    kit.deps.attention.countPending(),
    kit.deps.usage.costToday(),
  ]);
  return { settings, pending, costToday, now: new Date(), timezone: kit.deps.timezone };
}

export async function showMainMenu(kit: AdminKit, ctx: Context, opts: { fresh?: boolean } = {}): Promise<void> {
  await show(ctx, buildMainMenu(await loadMain(kit)), opts);
}

export async function showStatus(kit: AdminKit, ctx: Context): Promise<void> {
  const [main, connections] = await Promise.all([loadMain(kit), kit.deps.connections.listAuthorized()]);
  const c = connections[0];
  await show(ctx, buildStatus({ ...main, connection: c ? { isEnabled: c.isEnabled, canReply: c.canReply } : null }));
}

export async function showHelp(kit: AdminKit, ctx: Context): Promise<void> {
  const s = await kit.deps.settings.get();
  await show(ctx, buildHelp(s.ownerName));
}

export function registerMain(kit: AdminKit): void {
  const { router } = kit;
  router.action(ROUTES.menu, async (ctx) => {
    await showMainMenu(kit, ctx);
  });
  router.action('sts', async (ctx) => {
    await showStatus(kit, ctx);
    return 'Yangilandi';
  });
  router.action(NOP, async () => undefined);
  router.action(CANCEL, async (ctx) => {
    // The dispatcher keeps the pending input for this route so we know where to return.
    const adminId = adminIdOf(kit, ctx);
    const pending = await kit.states.get(adminId);
    await kit.states.clear(adminId);
    setNotice(ctx, '❎ Bekor qilindi.');
    const back = pending?.payload.back;
    if (typeof back === 'string' && back !== CANCEL && router.hasAction(parseCb(back).route)) await router.go(ctx, back);
    else await showMainMenu(kit, ctx);
    return 'Bekor qilindi';
  });
}
