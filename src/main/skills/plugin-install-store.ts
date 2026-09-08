// What plugins are installed where: one record per (workspace, source,
// plugin), app-level beside the source store. It is the receipt an uninstall
// reads — which skill directories the install copied, which Claude Code key it
// enabled — and what a later sync compares commits against.
//
// The workspace's own files stay the truth for what an agent reads (skill
// directories, the settings key); this store only says what Multicode wrote,
// so it can take it back and can tell an update from a first install.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { InstalledPluginRecord } from '../../shared/electron-api'

const FILE_NAME = 'plugin-installs.json'

type PersistedState = { schemaVersion: 1; plugins: InstalledPluginRecord[] }

export type PluginInstallStore = {
  list(workspaceRoot: string): Promise<InstalledPluginRecord[]>
  get(workspaceRoot: string, sourceId: string, pluginId: string): Promise<InstalledPluginRecord | null>
  put(record: InstalledPluginRecord): Promise<void>
  remove(workspaceRoot: string, sourceId: string, pluginId: string): Promise<boolean>
}

export function createPluginInstallStore(userDataDir: string): PluginInstallStore {
  const path = join(userDataDir, FILE_NAME)

  const read = async (): Promise<PersistedState> => {
    try {
      return parsePluginInstallState(await readFile(path, 'utf8'))
    } catch {
      return { schemaVersion: 1, plugins: [] }
    }
  }

  let writeChain: Promise<unknown> = Promise.resolve()
  const update = async (mutate: (state: PersistedState) => boolean): Promise<boolean> => {
    const run = writeChain.then(async () => {
      const state = await read()
      if (!mutate(state)) return false
      await mkdir(userDataDir, { recursive: true })
      const temp = `${path}.tmp`
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
      await rename(temp, path)
      return true
    })
    writeChain = run.catch(() => undefined)
    return run
  }

  const same = (a: InstalledPluginRecord, workspaceRoot: string, sourceId: string, pluginId: string): boolean =>
    a.workspaceRoot === workspaceRoot && a.sourceId === sourceId && a.pluginId === pluginId

  return {
    async list(workspaceRoot) {
      return (await read()).plugins.filter((record) => record.workspaceRoot === workspaceRoot)
    },
    async get(workspaceRoot, sourceId, pluginId) {
      return (await read()).plugins.find((record) => same(record, workspaceRoot, sourceId, pluginId)) ?? null
    },
    async put(record) {
      await update((state) => {
        const index = state.plugins.findIndex((existing) =>
          same(existing, record.workspaceRoot, record.sourceId, record.pluginId)
        )
        if (index === -1) state.plugins.push(record)
        else state.plugins[index] = record
        return true
      })
    },
    async remove(workspaceRoot, sourceId, pluginId) {
      return update((state) => {
        const index = state.plugins.findIndex((existing) => same(existing, workspaceRoot, sourceId, pluginId))
        if (index === -1) return false
        state.plugins.splice(index, 1)
        return true
      })
    },
  }
}

function parsePluginInstallState(raw: string): PersistedState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { schemaVersion: 1, plugins: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { schemaVersion: 1, plugins: [] }
  const plugins = (parsed as { plugins?: unknown }).plugins
  return {
    schemaVersion: 1,
    plugins: Array.isArray(plugins) ? plugins.filter(isRecord) : [],
  }
}

function isRecord(value: unknown): value is InstalledPluginRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.workspaceRoot === 'string'
    && typeof record.sourceId === 'string'
    && typeof record.pluginId === 'string'
    && Array.isArray(record.skillDirNames)
  )
}
