import React from 'react'

import type { AgentCli } from '../../types/workspace'

// Starred runtimes, kept in localStorage so they survive a restart, and shared
// by every mounted picker through one subscription — two open pickers must
// never disagree about what is starred.
//
// The store is a flat list of "<cli>:<model>" keys (the CLI's own default model
// is the empty model part). Ids, not labels: a catalog that relabels a model
// keeps the star, and a model that leaves the catalog simply stops matching
// any row rather than resurrecting as a ghost entry.

const STORAGE_KEY = 'multicode.model-favourites'

export function modelFavouriteKey(cli: AgentCli, model: string | null | undefined): string {
  return `${cli}:${model ?? ''}`
}

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    // localStorage can throw in restricted contexts, and a hand-corrupted value
    // must not take the picker down with it. No stars is the honest fallback:
    // every model is still reachable through its provider.
    return []
  }
}

let cache: string[] | null = null
const listeners = new Set<() => void>()

function snapshot(): string[] {
  if (cache === null) cache = read()
  return cache
}

function publish(next: string[]): void {
  cache = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The in-memory list still updates, so the session behaves; only the
    // survival across restarts is lost, which is exactly what a blocked
    // localStorage means.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function toggleModelFavourite(key: string): void {
  const current = snapshot()
  publish(current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])
}

/** Test seam: drops the shared cache so a suite can start from a known store. */
export function __resetModelFavouritesForTest(): void {
  cache = null
  for (const listener of listeners) listener()
}

export function useModelFavourites(): string[] {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot)
}
