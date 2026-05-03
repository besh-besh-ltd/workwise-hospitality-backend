// Time-mock helper for tests that exercise scheduler / cron / deadline-driven
// code paths in JS land (setTimeout, setInterval, Date.now()).
//
// IMPORTANT scope note:
// These helpers freeze JS time only — they do NOT affect Postgres NOW()
// or CURRENT_DATE. Tests that need "the cron sees row X as N days old"
// should set the row's timestamp/date column explicitly (e.g.
// `created_at = NOW() - INTERVAL '3 days'`) instead of relying on time
// freezing. The JS clock is what matters for setTimeout-based reminders
// and for Jest assertions on Date.now()-derived values.
//
// USAGE:
//
//   import { freezeTime, advanceTime, restoreTime } from "../helpers/time.js";
//
//   beforeEach(() => freezeTime("2026-05-03T10:00:00Z"));
//   afterEach(() => restoreTime());
//
//   it("cron at T+5min", async () => {
//     await advanceTime(5 * 60 * 1000);
//     // ...
//   });

import { jest } from "@jest/globals";

/**
 * Freeze the JS clock at the given instant. Subsequent `Date.now()`,
 * `new Date()`, and `setTimeout`/`setInterval` callbacks are driven by
 * the fake clock until `restoreTime()` is called.
 *
 * @param {Date | string | number} when
 */
export function freezeTime(when) {
  const target = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(target.getTime())) {
    throw new Error(`freezeTime: invalid date '${when}'`);
  }
  // doNotFake: keep `nextTick` and `queueMicrotask` real so awaits resolve.
  jest.useFakeTimers({
    now: target,
    doNotFake: ["nextTick", "queueMicrotask"],
  });
}

/**
 * Advance the fake clock by `ms` milliseconds. Any setTimeout / setInterval
 * callbacks scheduled to fire within that window are flushed synchronously
 * by Jest. After advancing, this helper drains the microtask queue so any
 * `await`-ed promises that depend on the new time can resolve before the
 * caller's next assertion runs.
 *
 * @param {number} ms
 */
export async function advanceTime(ms) {
  jest.advanceTimersByTime(ms);
  // Let pending awaits / promise.then handlers settle.
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Restore the real (system) clock. Call from afterEach to keep tests that
 * follow on the same worker isolated.
 */
export function restoreTime() {
  jest.useRealTimers();
}

/**
 * Run `fn` with the JS clock frozen at `when`, then restore. Convenience
 * wrapper for one-off tests that need a specific instant for a single
 * assertion.
 *
 * @template T
 * @param {Date | string | number} when
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFrozenTime(when, fn) {
  freezeTime(when);
  try {
    return await fn();
  } finally {
    restoreTime();
  }
}
