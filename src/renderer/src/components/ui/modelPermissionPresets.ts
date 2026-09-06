import React from 'react'

import { modelFavouriteKey } from './modelFavourites'
import type { AgentCli, SprintEngineCliPermissionPreset } from '../../types/workspace'

// The permission preset a model row spawns on, remembered PER ROW rather than
// once for the whole app (owner, 2026-09-05).
//
// A preset used to be one value every spawn read, set from a control standing
// beside the model picker. But a preset is a property OF the runtime the row
// names — Claude Code's own auto mode is not Codex's sandbox, and the repo you
// trust one model in is not the one you trust the next in — so it belongs in
// the picker with the model, and it has to be remembered against the row the
// way that row's model and effort already are.
//
// Keyed by `modelFavouriteKey` — the SAME "<cli>:<model>" identity the stars
// use, so a row has one id across everything the picker remembers about it, and
// a model that leaves the catalog simply stops matching rather than resurrecting
// as a ghost entry.
//
// A row that was never set has no entry, and resolves to the caller's fallback:
// `appSettings.lastAgentSpawnPermissionPreset`, the app-wide default that
// Settings still owns. So nothing changes for a row nobody has touched, and
// setting one row can never move another.

const STORAGE_KEY = 'multicode.model-permission-presets'

// Exhaustive over the union, so a preset added to the type fails the build here
// rather than being silently dropped on read as an unknown value.
const VALID: Record<SprintEngineCliPermissionPreset, true> = {
  none: true,
  manual: true,
  auto: true,
  bypass: true,
}

function isPreset(value: unknown): value is SprintEngineCliPermissionPreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALID, value)
}

type PresetMap = Readonly<Record<string, SprintEngineCliPermissionPreset>>

const EMPTY: PresetMap = {}

function read(): PresetMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY
    const next: Record<string, SprintEngineCliPermissionPreset> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A value this build does not recognise is dropped rather than carried:
      // an unknown preset would resolve to no flag at all at spawn time, which
      // is not what the row claims to say.
      if (key.length > 0 && isPreset(value)) next[key] = value
    }
    return next
  } catch {
    // localStorage throws in restricted contexts, and a hand-corrupted value
    // must not take the picker down with it. No overrides is the honest
    // fallback: every row then reads the app-wide default it always did.
    return EMPTY
  }
}

let cache: PresetMap | null = null
const listeners = new Set<() => void>()

function snapshot(): PresetMap {
  if (cache === null) cache = read()
  return cache
}

function publish(next: PresetMap): void {
  cache = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The in-memory map still updates, so the session behaves; only survival
    // across restarts is lost — exactly what a blocked localStorage means.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The preset stored against a row, or undefined when it was never set. */
export function storedModelPermissionPreset(
  cli: AgentCli | null | undefined,
  model: string | null | undefined,
): SprintEngineCliPermissionPreset | undefined {
  // No CLI is no row: a terminal and a conversation launch nothing that reads a
  // permission flag, so there is nothing stored against them.
  if (!cli) return undefined
  return snapshot()[modelFavouriteKey(cli, model)]
}

/**
 * What a spawn on this row actually launches with: the row's own preset, or the
 * app-wide default when the row has never been set. Read at SPAWN time, from
 * the row that was clicked — never from a value captured when the picker opened.
 */
export function resolveModelPermissionPreset(
  cli: AgentCli | null | undefined,
  model: string | null | undefined,
  fallback: SprintEngineCliPermissionPreset,
): SprintEngineCliPermissionPreset {
  return storedModelPermissionPreset(cli, model) ?? fallback
}

export function setModelPermissionPreset(
  cli: AgentCli | null | undefined,
  model: string | null | undefined,
  preset: SprintEngineCliPermissionPreset,
): void {
  if (!cli) return
  publish({ ...snapshot(), [modelFavouriteKey(cli, model)]: preset })
}

/**
 * Test seam: empties the store so a suite can start from a known one. It clears
 * the PERSISTED value, not just the cache — dropping the cache alone re-reads
 * whatever the last check wrote, which is how a preset set in one check leaks
 * into the next.
 */
export function __resetModelPermissionPresetsForTest(): void {
  publish(EMPTY)
}

/** The live preset for a row, re-rendering when any picker changes it. */
export function useModelPermissionPreset(
  cli: AgentCli | null | undefined,
  model: string | null | undefined,
  fallback: SprintEngineCliPermissionPreset,
): SprintEngineCliPermissionPreset {
  const map = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!cli) return fallback
  return map[modelFavouriteKey(cli, model)] ?? fallback
}
