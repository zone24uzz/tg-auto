/** Timezone helpers built on Intl (no external date library). */

function partsInTz(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset (ms) of `timeZone` from UTC at `date`. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = partsInTz(date, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight (in `timeZone`) for the day containing `date`. */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const p = partsInTz(date, timeZone);
  const localMidnightAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!);
  return new Date(localMidnightAsUtc - tzOffsetMs(date, timeZone));
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = partsInTz(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Next local occurrence of hh:00 in `timeZone` (used for "pause until tomorrow"). */
export function nextLocalTime(date: Date, timeZone: string, hour: number): Date {
  const midnight = startOfDayInTz(date, timeZone);
  let candidate = new Date(midnight.getTime() + hour * 3_600_000);
  if (candidate.getTime() <= date.getTime()) candidate = new Date(candidate.getTime() + 86_400_000);
  return candidate;
}

/** HH:MM in `timeZone`. */
export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** DD.MM HH:MM in `timeZone`. */
export function formatDateTime(date: Date, timeZone: string): string {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit' }).format(date);
  return `${d.replace('/', '.')} ${formatTime(date, timeZone)}`;
}

/** Human "2h ago" style (Uzbek). */
export function timeAgo(date: Date, now = new Date()): string {
  const sec = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (sec < 60) return 'hozirgina';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} daq oldin`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.round(h / 24);
  return `${d} kun oldin`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
