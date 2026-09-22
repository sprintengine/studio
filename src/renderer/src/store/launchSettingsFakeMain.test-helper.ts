/**
 * A stand-in for main's launch-settings store and its IPC, for the renderer
 * suites. It applies patches with the same shared functions main does, and
 * clones everything that crosses it the way IPC would, so a test can never
 * pass on a shared object reference.
 */
import {
  agentLaunchSettingsEqual,
  applyAgentLaunchSettingsPatch,
  emptyAgentLaunchSettings,
  normalizeAgentLaunchSettings,
  normalizeAgentLaunchSettingsPatch,
  type AgentLaunchSettings,
  type AgentLaunchSettingsPatch,
  type AgentLaunchSettingsRecord,
  type AgentLaunchSettingsWriteAck,
} from '../../../shared/launch-settings'
import type { LaunchSettingsApi } from './launchSettingsClient'

export type FakeLaunchSettingsMain = {
  api: LaunchSettingsApi
  calls: { get: number; update: AgentLaunchSettingsPatch[]; migrate: AgentLaunchSettings[] }
  record: () => AgentLaunchSettingsRecord | null
  /** A write another window (or main itself) makes: committed and broadcast. */
  externalUpdate: (patch: AgentLaunchSettingsPatch) => AgentLaunchSettingsRecord
  /** Deliver a record on the broadcast channel as it is, stale or not. */
  broadcast: (record: AgentLaunchSettingsRecord) => void
  /** Make the next `update` call reject, as a lost IPC would. */
  failNextUpdate: () => void
}

export function createFakeLaunchSettingsMain(initial: AgentLaunchSettings | null = null): FakeLaunchSettingsMain {
  let record: AgentLaunchSettingsRecord | null = null
  let failNext = false
  const listeners = new Set<(record: AgentLaunchSettingsRecord) => void>()
  const calls: FakeLaunchSettingsMain['calls'] = { get: 0, update: [], migrate: [] }

  function commit(settings: AgentLaunchSettings): AgentLaunchSettingsRecord {
    record = {
      schemaVersion: 1,
      revision: (record?.revision ?? 0) + 1,
      settings,
      changedAt: 0,
      lastWrite: { actor: 'ui', at: '' },
    }
    for (const listener of listeners) listener(structuredClone(record))
    return record
  }

  function update(patch: unknown): AgentLaunchSettingsWriteAck {
    const next = applyAgentLaunchSettingsPatch(
      record?.settings ?? emptyAgentLaunchSettings(),
      normalizeAgentLaunchSettingsPatch(patch),
    )
    if (record && agentLaunchSettingsEqual(record.settings, next)) return { ok: true, record, changed: false }
    return { ok: true, record: commit(next), changed: true }
  }

  if (initial) commit(normalizeAgentLaunchSettings(initial))

  const api: LaunchSettingsApi = {
    launchSettingsGet: async () => {
      calls.get += 1
      return structuredClone({ record, settings: record?.settings ?? emptyAgentLaunchSettings() })
    },
    launchSettingsUpdate: async (patch) => {
      calls.update.push(structuredClone(patch))
      if (failNext) {
        failNext = false
        throw new Error('ipc lost')
      }
      return structuredClone(update(structuredClone(patch)))
    },
    launchSettingsMigrate: async (settings) => {
      calls.migrate.push(structuredClone(settings))
      if (record) return structuredClone({ ok: true as const, record, changed: false })
      return structuredClone({
        ok: true as const,
        record: commit(normalizeAgentLaunchSettings(settings)),
        changed: true,
      })
    },
    onLaunchSettingsChanged: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  return {
    api,
    calls,
    record: () => record,
    externalUpdate: (patch) => update(patch).record,
    broadcast: (next) => {
      for (const listener of listeners) listener(structuredClone(next))
    },
    failNextUpdate: () => {
      failNext = true
    },
  }
}

/** Let queued promise callbacks (the fake IPC round-trips) run. */
export async function settleIpc(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A Map-backed localStorage and the window the store module reads at import. */
export function installFakeWindow(api: object, seed: Record<string, string> = {}): Map<string, string> {
  const stored = new Map(Object.entries(seed))
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  }
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { href: 'http://localhost/?windowId=primary', search: '' },
      localStorage,
      api,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true })
  return stored
}
