import type { Settings } from '../settings/schema.js';
import { formatTime, tzOffsetMs } from '../utils/time.js';

/** What contacts may be told about the owner right now — only what the owner set themselves. */
export interface Availability {
  /** "Busy now" mode set by the owner, still running. */
  busy: { until: Date; note: string } | null;
  /** Outside the owner's working hours (or a day off). */
  offHours: boolean;
  /** Next start of working hours (local HH:MM shown to contacts), when offHours. */
  nextStart: string | null;
}

type AvailabilitySettings = Pick<Settings, 'busyUntil' | 'busyNote' | 'workHoursEnabled' | 'workStart' | 'workEnd' | 'weekendDays'>;

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local weekday (0 = Sunday) and minute of the day in `timezone`. */
function localClock(now: Date, timezone: string): { weekday: number; minute: number } {
  const local = new Date(now.getTime() + tzOffsetMs(now, timezone));
  return { weekday: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/**
 * Is `now` inside working hours? Supports overnight ranges (e.g. 20:00–04:00) and days off.
 * A range that starts on a working day and runs past midnight still counts on the next day.
 */
export function isWorkingTime(s: Pick<Settings, 'workStart' | 'workEnd' | 'weekendDays'>, now: Date, timezone: string): boolean {
  const { weekday, minute } = localClock(now, timezone);
  const start = minutesOf(s.workStart);
  const end = minutesOf(s.workEnd);
  const off = (day: number) => s.weekendDays.includes(((day % 7) + 7) % 7);
  if (start === end) return !off(weekday); // 24 hours
  if (start < end) return !off(weekday) && minute >= start && minute < end;
  // Overnight: the evening part belongs to today, the early-morning part to yesterday's shift.
  if (minute >= start) return !off(weekday);
  if (minute < end) return !off(weekday - 1);
  return false;
}

export function availabilityOf(s: AvailabilitySettings, now: Date, timezone: string): Availability {
  const until = s.busyUntil ? new Date(s.busyUntil) : null;
  const busy = until && until.getTime() > now.getTime() ? { until, note: s.busyNote.trim() } : null;
  const offHours = s.workHoursEnabled && !isWorkingTime(s, now, timezone);
  return { busy, offHours, nextStart: offHours ? s.workStart : null };
}

/** Fills {owner} {note} {until} {start} in an owner-written notice. */
export function fillNotice(template: string, v: { owner: string; note?: string; until?: Date; start?: string | null; timezone: string }): string {
  const note = v.note?.trim() ?? '';
  // Without a note, "band ({note})" becomes just "band".
  const base = note ? template : template.replace(/\s*\(\s*\{note\}\s*\)/gu, '');
  return base
    .replaceAll('{owner}', v.owner)
    .replaceAll('{note}', note)
    .replaceAll('{until}', v.until ? formatTime(v.until, v.timezone) : '')
    .replaceAll('{start}', v.start ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Prompt section for the reply model. Only owner-set facts: the AI may mention them, nothing else.
 * Empty when there is nothing to tell.
 */
export function availabilitySection(a: Availability, ownerName: string, timezone: string): string {
  const lines: string[] = [];
  if (a.busy) {
    lines.push(
      `${ownerName} set "busy" mode until ${formatTime(a.busy.until, timezone)}${a.busy.note ? ` (${a.busy.note})` : ''}. If the contact asks for ${ownerName} or wants a quick answer from them, you may say ${ownerName} is busy${a.busy.note ? ` (${a.busy.note})` : ''} and will reply after ${formatTime(a.busy.until, timezone)}.`,
    );
  }
  if (a.offHours) {
    lines.push(
      `It is outside ${ownerName}'s working hours now. If the contact needs ${ownerName} personally, you may say ${ownerName} will reply during working hours${a.nextStart ? ` (from ${a.nextStart})` : ''}.`,
    );
  }
  if (lines.length === 0) return '';
  return [
    `## ${ownerName}'s status (set by ${ownerName}; this overrides rule 3 and the owner instructions only for these facts)`,
    ...lines,
    'Say nothing else about where they are or what they are doing.',
  ].join('\n');
}
