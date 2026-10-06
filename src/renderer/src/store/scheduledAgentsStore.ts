// The scheduled agents, as every surface in this window reads them: one fetch,
// then main's broadcast after every change — a write from any window, an
// extension or an agent, and each run's outcome. Main owns the list; this is
// its mirror.

import { useSyncExternalStore } from 'react'

import type { ScheduledAgentView } from '../../../shared/scheduled-agents'

const EMPTY: ScheduledAgentView[] = []
let agents: ScheduledAgentView[] = EMPTY
let started = false
// Whether a broadcast has landed: main sends the whole list on every change,
// so one that arrives before the first fetch answers is newer than that answer.
let broadcastSeen = false
const listeners = new Set<() => void>()

function publish(next: unknown): void {
  // Anything but a list is no list: an older main, or a stubbed bridge.
  agents = Array.isArray(next) ? (next as ScheduledAgentView[]) : EMPTY
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const bridge = typeof window === 'undefined' ? undefined : (window.api as Partial<Window['api']> | undefined)
  // An older preload, or a test that stubs none of this: no scheduled agents.
  if (typeof bridge?.listScheduledAgents !== 'function') return
  bridge.onScheduledAgentsChanged?.((next) => {
    broadcastSeen = true
    publish(next)
  })
  void bridge
    .listScheduledAgents()
    .then((listed) => {
      if (!broadcastSeen) publish(listed)
    })
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useScheduledAgents(): ScheduledAgentView[] {
  return useSyncExternalStore(subscribe, () => agents)
}

/** Test seam: forget the mirror and its subscription. */
export function resetScheduledAgentsStoreForTests(): void {
  agents = EMPTY
  started = false
  broadcastSeen = false
  listeners.clear()
}
