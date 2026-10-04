import { AllProvidersFailedError } from '../ai/types.js';

/** Temporary AI quota/rate limits (provider 429/RESOURCE_EXHAUSTED or the global per-minute limiter). */
export const RATE_LIMIT_RE = /\b429\b|RESOURCE_EXHAUSTED|RATE_LIMIT|rate.?limit|requests-per-minute|quota/i;

/** True when every provider attempt failed because of a (temporary) rate limit. */
export function isRateLimitFailure(error: unknown): boolean {
  if (error instanceof AllProvidersFailedError) return error.attempts.length > 0 && error.attempts.every((a) => RATE_LIMIT_RE.test(a.error));
  return false;
}
