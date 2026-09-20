/** Outbox retry scheduling (SYNC05): exponential delay with jitter from 2s up to 5 minutes. */

export const OUTBOX_MIN_DELAY_MS = 2_000;
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;
export const OUTBOX_MAX_IN_FLIGHT = 20;
/** Stale in_flight ops older than this are reclaimed on automatic drain (crash / hung fetch). */
export const OUTBOX_IN_FLIGHT_LEASE_MS = 60_000;

export type RandomUnitFn = () => number;

export function outboxRetryDelayMs(attempts: number, random: RandomUnitFn = Math.random): number {
  const safeAttempts = Math.max(0, Math.floor(attempts));
  const base = Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_MIN_DELAY_MS * 2 ** safeAttempts);
  const jitter = 0.5 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.min(OUTBOX_MAX_DELAY_MS, Math.floor(base * jitter));
}

export function nextAttemptAtIso(
  attempts: number,
  nowMs: number = Date.now(),
  random: RandomUnitFn = Math.random,
): string {
  return new Date(nowMs + outboxRetryDelayMs(attempts, random)).toISOString();
}
