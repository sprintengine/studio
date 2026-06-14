// Self-registration registry for the renderer's recurring supervisors (the
// setInterval/rAF loops we had to grep for during the perf investigation). Each
// supervisor registers a label + cadence and reports tick cost; the panel then
// shows what's looping, how often, and how expensive each tick is — no guessing.
export type TimerRegistration = {
  id: number
  label: string
  cadenceMs: number
  tickCount: number
  totalMs: number
  maxMs: number
  lastTickAt: number | null
  startedAt: number
}

export type TimerRegistrationRow = {
  label: string
  cadenceMs: number
  tickCount: number
  avgMs: number | null
  maxMs: number | null
  lastTickAt: number | null
}

export type TimerHandle = {
  recordTick: (elapsedMs: number) => void
  unregister: () => void
}

let nextId = 1
const timers = new Map<number, TimerRegistration>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function registerTimer(label: string, cadenceMs: number, now = Date.now()): TimerHandle {
  const id = nextId++
  timers.set(id, { id, label, cadenceMs, tickCount: 0, totalMs: 0, maxMs: 0, lastTickAt: null, startedAt: now })
  emit()
  return {
    recordTick: (elapsedMs: number, at = Date.now()) => {
      const entry = timers.get(id)
      if (!entry) return
      entry.tickCount += 1
      entry.totalMs += elapsedMs
      entry.maxMs = Math.max(entry.maxMs, elapsedMs)
      entry.lastTickAt = at
      emit()
    },
    unregister: () => {
      timers.delete(id)
      emit()
    },
  }
}

export function getTimerRegistrations(): TimerRegistration[] {
  return [...timers.values()]
}

export function subscribeTimers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Collapses raw registrations into display rows (avg cost per tick), sorted by
// avg cost so the most expensive loop floats to the top.
export function summarizeTimers(input: readonly TimerRegistration[]): TimerRegistrationRow[] {
  const rows = input.map((entry) => ({
    label: entry.label,
    cadenceMs: entry.cadenceMs,
    tickCount: entry.tickCount,
    avgMs: entry.tickCount > 0 ? Math.round((entry.totalMs / entry.tickCount) * 10) / 10 : null,
    maxMs: entry.tickCount > 0 ? Math.round(entry.maxMs * 10) / 10 : null,
    lastTickAt: entry.lastTickAt,
  }))
  rows.sort((a, b) => (b.avgMs ?? -1) - (a.avgMs ?? -1) || a.label.localeCompare(b.label))
  return rows
}
