import { formatDateTime } from '../../../utils/time.js';
import { escapeHtml } from '../../common/html.js';
import { cb } from '../callback-data.js';
import type { AdminKit } from '../kit.js';
import { Kb, fit, pageArg, show, type View } from '../ui.js';

export const EVENTS_PER_PAGE = 15;
export const AUDIT_PER_PAGE = 10;

export interface EventRow {
  level: string;
  source: string;
  message: string;
  createdAt: Date;
}

export interface AuditRow {
  action: string;
  target: string | null;
  createdAt: Date;
}

const LEVEL_ICON: Record<string, string> = { INFO: 'ℹ️', WARN: '⚠️', ERROR: '❌' };

const MAX_HTML = 3900;
/** Progressively shorter per-line budgets so a page always fits one Telegram message. */
const BUDGETS = [
  { source: 40, message: 160, target: 60 },
  { source: 24, message: 90, target: 40 },
  { source: 16, message: 45, target: 24 },
  { source: 10, message: 20, target: 12 },
];

function renderLogs(events: EventRow[], audits: AuditRow[], page: number, timezone: string, b: (typeof BUDGETS)[number]): string {
  const lines = [`📜 <b>LOGS</b> — sahifa ${page + 1}`, '', '<b>Tizim hodisalari</b>'];
  if (events.length === 0) lines.push('—');
  for (const e of events) {
    lines.push(`${LEVEL_ICON[e.level] ?? '•'} ${formatDateTime(e.createdAt, timezone)} <b>${fit(e.source, b.source)}</b> — ${fit(e.message, b.message)}`);
  }
  lines.push('', '<b>Audit (admin amallari)</b>');
  if (audits.length === 0) lines.push('—');
  for (const a of audits) {
    lines.push(`• ${formatDateTime(a.createdAt, timezone)} ${escapeHtml(a.action)}${a.target ? ` — <code>${fit(a.target, b.target)}</code>` : ''}`);
  }
  return lines.join('\n');
}

export function buildLogs(events: EventRow[], audits: AuditRow[], page: number, timezone: string): View {
  let text = '';
  for (const budget of BUDGETS) {
    text = renderLogs(events, audits, page, timezone, budget);
    if (text.length <= MAX_HTML) break;
  }
  const hasNext = events.length === EVENTS_PER_PAGE || audits.length === AUDIT_PER_PAGE;
  const kb = new Kb().simplePager(page, hasNext, (p) => cb('lg', p)).back();
  return { text, keyboard: kb.build() };
}

export function registerLogs(kit: AdminKit): void {
  const { deps } = kit;
  kit.router.action('lg', async (ctx, [raw]) => {
    const page = pageArg(raw);
    const [events, audits] = await Promise.all([
      deps.events.recent(EVENTS_PER_PAGE, page * EVENTS_PER_PAGE),
      deps.audit.recent(AUDIT_PER_PAGE, page * AUDIT_PER_PAGE),
    ]);
    await show(ctx, buildLogs(events, audits, page, deps.timezone));
  });
}
