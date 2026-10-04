import type { Settings } from '../settings/schema.js';

/**
 * Target delay (ms) before sending a reply, measured from when the message arrived.
 * Time already spent on classification/generation counts towards it.
 */
export function targetDelayMs(
  settings: Pick<Settings, 'responseDelayMode' | 'customDelayMinSec' | 'customDelayMaxSec'>,
  replyLength: number,
  random: () => number = Math.random,
): number {
  switch (settings.responseDelayMode) {
    case 'OFF':
      return 0;
    case 'FAST':
      return 1_000 + Math.round(random() * 1_000);
    case 'NATURAL': {
      // ~1.5 s to "read" + roughly 25 characters per second of "typing", capped at 12 s.
      const typing = (replyLength / 25) * 1_000;
      return Math.min(12_000, 1_500 + typing + Math.round(random() * 800));
    }
    case 'CUSTOM': {
      const min = Math.min(settings.customDelayMinSec, settings.customDelayMaxSec) * 1_000;
      const max = Math.max(settings.customDelayMinSec, settings.customDelayMaxSec) * 1_000;
      return Math.round(min + random() * (max - min));
    }
    default:
      return 0;
  }
}

export function remainingDelayMs(targetMs: number, startedAt: number, now = Date.now()): number {
  return Math.max(0, targetMs - (now - startedAt));
}
