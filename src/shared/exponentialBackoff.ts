// Reusable exponential-backoff schedule. Pure and clock-free so any polling loop
// can compute its own next delay and be unit-tested without timers. The classic
// shape is `base, base·f, base·f², …` capped at `maxMs`; whether the schedule
// holds at the cap forever or stops there is the caller's choice via `stopAtMax`.
//
// Lives in `shared/` because the schedule it defines is driven from MAIN: a
// main-process poller owns its probe cycle rather than a renderer supervisor,
// and a window closing must not change the schedule.

export type ExponentialBackoffOptions = {
  // Delay before the first attempt (attempt 0).
  baseMs: number
  // Growth multiplier applied per attempt. Defaults to 2 (doubling).
  factor?: number
  // Ceiling for a single delay.
  maxMs: number
  // When true, the schedule is exhausted (returns null) the first time the
  // uncapped delay would exceed `maxMs` — i.e. after the attempt taken at the
  // cap. When false (the default), delays clamp to `maxMs` and repeat forever.
  stopAtMax?: boolean
}

// Delay (ms) to wait before attempt `attempt` (0-indexed), or null once the
// schedule is exhausted. `null` means "stop until re-armed" for a `stopAtMax`
// schedule; a non-stopping schedule never returns null. Pure: same inputs always
// map to the same output, with no reliance on the clock or prior calls.
export function backoffDelayMs(attempt: number, opts: ExponentialBackoffOptions): number | null {
  const { baseMs, factor = 2, maxMs, stopAtMax = false } = opts
  if (!Number.isInteger(attempt) || attempt < 0) return null
  const raw = baseMs * Math.pow(factor, attempt)
  if (raw <= maxMs) return raw
  return stopAtMax ? null : maxMs
}
