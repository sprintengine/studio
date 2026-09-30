// When scheduled agents run. One timer, armed for the soonest next run across
// every scheduled agent, re-armed after each run and whenever the list changes.
//
// Missed runs: a schedule that came round while the app was closed is not
// replayed — the next run is counted from start-up. One that came round while
// the computer slept, with the app open, runs once on waking: the timer was
// armed for it, and a run late by the length of a nap is still the run the
// person asked for. Several missed times of the same schedule run once, not
// once each.

import { nextScheduledAgentRun, type ScheduledAgent, type ScheduledAgentLastRun } from '../../shared/scheduled-agents'

// A timer longer than this is re-armed rather than trusted: a changed clock or
// a long sleep moves what "the soonest run" means, and setTimeout's own limit
// is about 24.8 days.
const MAX_TIMER_MS = 60 * 60 * 1000

export type ScheduledAgentsSchedulerDeps = {
  list: () => ScheduledAgent[]
  run: (agent: ScheduledAgent) => Promise<ScheduledAgentLastRun>
  recordRun: (id: string, run: ScheduledAgentLastRun) => Promise<void>
  onRan?: (agent: ScheduledAgent, run: ScheduledAgentLastRun) => void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type ScheduledAgentsScheduler = {
  start(): void
  stop(): void
  /** The list changed, or the computer woke: work out the due times again. */
  refresh(): void
  /** When each scheduled agent runs next, as the scheduler will fire it. */
  nextRunAt(id: string): number | null
  isRunning(): boolean
  runNow(id: string): Promise<ScheduledAgentLastRun | null>
}

export function createScheduledAgentsScheduler(deps: ScheduledAgentsSchedulerDeps): ScheduledAgentsScheduler {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let running = false
  let timer: unknown = null
  // Each agent's due time, counted forward from when it was last scheduled —
  // never recomputed from "now" on a refresh, or a run due during a sleep
  // would be skipped the moment the computer woke and refreshed.
  const dueAt = new Map<string, { at: number | null; cron: string; timezone: string }>()
  const inFlight = new Set<string>()

  const dueFor = (agent: ScheduledAgent, after: number): number | null => nextScheduledAgentRun(agent.schedule, after)

  const reconcile = (): void => {
    const agents = deps.list()
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of [...dueAt.keys()]) if (!ids.has(id)) dueAt.delete(id)
    for (const agent of agents) {
      const known = dueAt.get(agent.id)
      // A new agent, or one whose schedule changed, counts from now.
      if (!known || known.cron !== agent.schedule.cron || known.timezone !== agent.schedule.timezone) {
        dueAt.set(agent.id, {
          at: dueFor(agent, now()),
          cron: agent.schedule.cron,
          timezone: agent.schedule.timezone,
        })
      }
    }
  }

  const arm = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!running) return
    let soonest: number | null = null
    for (const entry of dueAt.values()) {
      if (entry.at !== null && (soonest === null || entry.at < soonest)) soonest = entry.at
    }
    if (soonest === null) return
    const delay = Math.max(0, Math.min(soonest - now(), MAX_TIMER_MS))
    timer = setTimer(tick, delay)
  }

  const fire = async (agent: ScheduledAgent): Promise<ScheduledAgentLastRun | null> => {
    if (inFlight.has(agent.id)) return null
    inFlight.add(agent.id)
    try {
      const run = await deps.run(agent).catch((error: unknown): ScheduledAgentLastRun => ({
        at: now(),
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      // A scheduled agent closed while its run was starting is gone; its run
      // is not recorded against nothing.
      if (deps.list().some((candidate) => candidate.id === agent.id)) await deps.recordRun(agent.id, run)
      deps.onRan?.(agent, run)
      return run
    } finally {
      inFlight.delete(agent.id)
    }
  }

  function tick(): void {
    timer = null
    if (!running) return
    reconcile()
    const at = now()
    for (const agent of deps.list()) {
      const entry = dueAt.get(agent.id)
      if (!entry || entry.at === null || entry.at > at) continue
      // The next time counts from now, so every time missed in a long sleep
      // collapses into the one run below.
      entry.at = dueFor(agent, at)
      void fire(agent)
    }
    arm()
  }

  return {
    start() {
      if (running) return
      running = true
      dueAt.clear()
      reconcile()
      arm()
    },
    stop() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    refresh() {
      if (!running) return
      // The armed timer is for the old list: let go of it before re-arming.
      if (timer !== null) clearTimer(timer)
      timer = null
      reconcile()
      // Anything already due (the computer just woke) runs now.
      tick()
    },
    nextRunAt(id) {
      const entry = dueAt.get(id)
      if (entry) return entry.at
      const agent = deps.list().find((candidate) => candidate.id === id)
      return agent ? dueFor(agent, now()) : null
    },
    isRunning: () => running,
    async runNow(id) {
      const agent = deps.list().find((candidate) => candidate.id === id)
      return agent ? fire(agent) : null
    },
  }
}
