import { describe, expect, it } from 'vitest';
import {
  bytesFromMb,
  checkDuration,
  checkSize,
  computeFrameTimestamps,
  effectiveDurationSec,
  formatDuration,
  truncateChars,
  videoNoteFramePlan,
} from '../../src/media/limits.js';

function assertWellFormed(ts: number[], duration: number, maxFrames: number): void {
  expect(ts.length).toBeGreaterThanOrEqual(1);
  expect(ts.length).toBeLessThanOrEqual(maxFrames);
  for (let i = 0; i < ts.length; i++) {
    expect(ts[i]).toBeGreaterThanOrEqual(0);
    expect(ts[i]).toBeLessThan(duration);
    if (i > 0) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
  }
}

describe('size / duration limits', () => {
  it('converts megabytes to bytes', () => {
    expect(bytesFromMb(1)).toBe(1_048_576);
    expect(bytesFromMb(0.5)).toBe(524_288);
    expect(bytesFromMb(0)).toBe(0);
    expect(bytesFromMb(Number.NaN)).toBe(0);
  });

  it('checks sizes (unknown passes, boundary is inclusive)', () => {
    expect(checkSize(undefined, 10).ok).toBe(true);
    expect(checkSize(null, 10).ok).toBe(true);
    expect(checkSize(10 * 1_048_576, 10).ok).toBe(true);
    const over = checkSize(10 * 1_048_576 + 1, 10);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/exceeds/);
  });

  it('checks durations', () => {
    expect(checkDuration(undefined, 60).ok).toBe(true);
    expect(checkDuration(60, 60).ok).toBe(true);
    expect(checkDuration(61, 60).ok).toBe(false);
  });

  it('SEC-01: limits use the longest known duration (a sender cannot understate it)', () => {
    expect(effectiveDurationSec(3600, 5)).toBe(3600);
    expect(effectiveDurationSec(5, 3600)).toBe(3600);
    expect(effectiveDurationSec(undefined, 12)).toBe(12);
    expect(effectiveDurationSec(12.4, null)).toBe(12.4);
    expect(effectiveDurationSec(undefined, null)).toBeUndefined();
    expect(effectiveDurationSec(Number.NaN, -3, 0)).toBeUndefined();
    expect(checkDuration(effectiveDurationSec(3600, 5), 600).ok).toBe(false);
  });
});

describe('computeFrameTimestamps', () => {
  it('spreads frames evenly at the configured interval', () => {
    expect(computeFrameTimestamps(20, 5, 6)).toEqual([2.5, 7.5, 12.5, 17.5]);
  });

  it('widens the interval instead of exceeding maxFrames', () => {
    const ts = computeFrameTimestamps(45, 5, 6);
    expect(ts).toHaveLength(6);
    assertWellFormed(ts, 45, 6);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(7.5, 3);
  });

  it('caps very long videos at maxFrames', () => {
    const ts = computeFrameTimestamps(3600, 0.5, 30);
    expect(ts).toHaveLength(30);
    assertWellFormed(ts, 3600, 30);
    expect(ts[1]! - ts[0]!).toBeCloseTo(120, 3);
  });

  it('returns one frame for clips shorter than the interval', () => {
    expect(computeFrameTimestamps(3, 5, 6)).toEqual([1.5]);
    const tiny = computeFrameTimestamps(0.4, 5, 6);
    expect(tiny).toHaveLength(1);
    assertWellFormed(tiny, 0.4, 1);
  });

  it('handles unknown/invalid durations and maxFrames', () => {
    expect(computeFrameTimestamps(0, 5, 6)).toEqual([0]);
    expect(computeFrameTimestamps(Number.NaN, 5, 6)).toEqual([0]);
    expect(computeFrameTimestamps(30, 5, 0)).toHaveLength(1);
    expect(computeFrameTimestamps(30, 0, 4)).toHaveLength(1);
  });

  it('never returns more frames than maxFrames for any input', () => {
    for (const duration of [0.1, 1, 2.5, 9.99, 10, 59, 61, 179, 3600]) {
      for (const interval of [0.5, 1, 5, 30]) {
        for (const max of [1, 3, 6, 30]) {
          assertWellFormed(computeFrameTimestamps(duration, interval, max), duration, max);
        }
      }
    }
  });
});

describe('videoNoteFramePlan', () => {
  it('uses at most 4 frames at 384 px', () => {
    const plan = videoNoteFramePlan(20);
    expect(plan.scaleWidth).toBe(384);
    expect(plan.timestamps).toHaveLength(4);
    assertWellFormed(plan.timestamps, 20, 4);
  });

  it('handles full-length, short and over-long notes', () => {
    expect(videoNoteFramePlan(60).timestamps).toHaveLength(4);
    expect(videoNoteFramePlan(3).timestamps).toHaveLength(1);
    const long = videoNoteFramePlan(120).timestamps;
    expect(long.length).toBeLessThanOrEqual(4);
    for (const t of long) expect(t).toBeLessThan(60);
  });

  it('respects a lower maxFrames setting', () => {
    expect(videoNoteFramePlan(40, 2).timestamps).toHaveLength(2);
    expect(videoNoteFramePlan(40, 10).timestamps).toHaveLength(4);
  });
});

describe('text helpers', () => {
  it('truncates and reports truncation', () => {
    expect(truncateChars('hello', 10)).toEqual({ text: 'hello', truncated: false });
    expect(truncateChars('hello world', 5)).toEqual({ text: 'hello', truncated: true });
    // never splits a surrogate pair
    const r = truncateChars('ab😀cd', 3);
    expect(r.text).toBe('ab');
    expect(r.truncated).toBe(true);
  });

  it('formats durations', () => {
    expect(formatDuration(12)).toBe('12s');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(3720)).toBe('1h 2m');
  });
});
