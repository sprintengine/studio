import React from 'react'

import type { AgentCli, CliPermissionPreset } from '../../types/workspace'

// The permission preset an agent spawns on, remembered PER CLI: one value for
// Claude Code, one for Codex, and so on (owner ruling 2026-09-24).
//
// A preset is a property of the runtime, not of the app — Claude Code's auto
// mode is not Codex's sandbox, and the two CLIs do not even name their presets
// the same way — so one app-wide value cannot say what a person wants from
// both. But it is not a property of the MODEL either. It was remembered per
// model row for a while (owner, 2026-09-05), and that meant choosing Bypass for
// one Claude model and then choosing it again for every other Claude model the
// picker offered. A person trusts a runtime in a repository; which of its
// models they happen to pick does not change that. So every model of a CLI
// reads and writes the same entry.
//
// A CLI that was never set has no entry and resolves to the caller's fallback:
// `appSettings.lastAgentSpawnPermissionPreset`, the app-wide default that
// Settings still owns. So nothing changes for a CLI nobody has touched, and
// setting one CLI can never move another.

const STORAGE_KEY = 'sprintengine.cli-permission-presets'

// Where the per-model-row store lived. It is not carried over: those entries
// were keyed "<cli>:<model>", several rows of one CLI could disagree, and no
// order among them says which was chosen last. Every CLI they covered simply
// reads the app-wide default again until someone picks once. The key is
// removed on first read so a stale map does not sit in the profile forever.
const RETIRED_PER_MODEL_STORAGE_KEY = 'sprintengine.model-permission-presets'

// Exhaustive over the union, so a preset added to the type fails the build here
// rather than being silently dropped on read as an unknown value.
const VALID: Record<CliPermissionPreset, true> = {
  none: true,
  manual: true,
  auto: true,
  bypass: true,
}

function isPreset(value: unknown): value is CliPermissionPreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALID, value)
}

type PresetMap = Readonly<Record<string, CliPermissionPreset>>

const EMPTY: PresetMap = {}

function read(): PresetMap {
  try {
    window.localStorage.removeItem(RETIRED_PER_MODEL_STORAGE_KEY)
  } catch {
    // Nothing reads the retired key, so failing to drop it costs only the bytes.
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY
    const next: Record<string, CliPermissionPreset> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A value this build does not recognise is dropped rather than carried:
      // an unknown preset would resolve to no flag at all at spawn time, which
      // is not what the picker claims to say.
      if (key.length > 0 && isPreset(value)) next[key] = value
    }
    return next
  } catch {
    // localStorage throws in restricted contexts, and a hand-corrupted value
    // must not take the picker down with it. No overrides is the honest
    // fallback: every CLI then reads the app-wide default it always did.
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

/** The preset stored against a CLI, or undefined when it was never set. */
export function storedCliPermissionPreset(cli: AgentCli | null | undefined): CliPermissionPreset | undefined {
  // No CLI, nothing stored: a terminal and a conversation launch nothing that
  // reads a permission flag.
  if (!cli) return undefined
  return snapshot()[cli]
}

/**
 * What a spawn on this CLI actually launches with: the CLI's own preset, or the
 * app-wide default when it has never been set. Read at SPAWN time, for the CLI
 * being launched — never from a value captured when the picker opened.
 */
export function resolveCliPermissionPreset(
  cli: AgentCli | null | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  return storedCliPermissionPreset(cli) ?? fallback
}

export function setCliPermissionPreset(cli: AgentCli | null | undefined, preset: CliPermissionPreset): void {
  if (!cli) return
  publish({ ...snapshot(), [cli]: preset })
}

/**
 * Test seam: empties the store so a suite can start from a known one. It clears
 * the PERSISTED value, not just the cache — dropping the cache alone re-reads
 * whatever the last check wrote, which is how a preset set in one check leaks
 * into the next.
 */
export function __resetCliPermissionPresetsForTest(): void {
  publish(EMPTY)
}

/**
 * Test seam: forgets the in-memory copy so the next read goes back to
 * localStorage, the way a fresh app start does.
 */
export function __reloadCliPermissionPresetsForTest(): void {
  cache = null
  for (const listener of listeners) listener()
}

/** The live preset for a CLI, re-rendering when any picker changes it. */
export function useCliPermissionPreset(
  cli: AgentCli | null | undefined,
  fallback: CliPermissionPreset,
): CliPermissionPreset {
  const map = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!cli) return fallback
  return map[cli] ?? fallback
}
