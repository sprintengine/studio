// Where the user's skill sources live.
//
// Sources are app-level, not workspace-level: a repository you added is a
// repository you added, and re-adding it in every workspace would be busywork.
// Installing is the workspace-level half — see install.ts. They persist in
// userData next to the GitHub token, and each source's scan result is cached
// beside it so reopening a source costs nothing and Sync is the only refresh.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BUILTIN_SKILL_SOURCE_ID,
  CONNECTORS_SKILL_SOURCE_ID,
  type ScanResult,
  type SkillSource,
} from '../../shared/skills'

const FILE_NAME = 'skill-sources.json'

/** The two sources every install has, which cannot be removed. */
export const ALWAYS_PRESENT_SKILL_SOURCES: readonly SkillSource[] = [
  {
    id: BUILTIN_SKILL_SOURCE_ID,
    kind: 'builtin',
    name: 'Multicode',
    repo: '',
    monogram: 'MC',
    blurb: 'The skills Multicode ships.',
    commitSha: '',
    scannedAt: '',
  },
  {
    id: CONNECTORS_SKILL_SOURCE_ID,
    kind: 'connectors',
    name: 'Connectors',
    repo: '',
    monogram: 'CO',
    blurb: 'Skills published by the tools you connect to.',
    commitSha: '',
    scannedAt: '',
  },
]

export function isRemovableSkillSource(id: string): boolean {
  return !ALWAYS_PRESENT_SKILL_SOURCES.some((source) => source.id === id)
}

type PersistedState = {
  sources: SkillSource[]
  scans: Record<string, ScanResult>
  /** True once the retired skill packs have been offered adoption — see adopt-legacy-packs.ts. */
  adoptedLegacyPacks: boolean
}

export type SkillSourceStore = {
  listSources(): Promise<SkillSource[]>
  getSource(id: string): Promise<SkillSource | null>
  /** A null scan records the source without claiming to know what it holds. */
  putSource(source: SkillSource, scan: ScanResult | null): Promise<void>
  removeSource(id: string): Promise<boolean>
  getScan(id: string): Promise<ScanResult | null>
  hasAdoptedLegacyPacks(): Promise<boolean>
  markLegacyPacksAdopted(): Promise<void>
}

export function createSkillSourceStore(userDataDir: string): SkillSourceStore {
  const path = join(userDataDir, FILE_NAME)

  const read = async (): Promise<PersistedState> => {
    try {
      return parseSkillSourceState(await readFile(path, 'utf8'))
    } catch {
      return emptyState()
    }
  }

  // Serialized read-modify-write: adding two sources in quick succession must
  // not lose one to a stale in-memory copy.
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

  return {
    async listSources() {
      const state = await read()
      return [...ALWAYS_PRESENT_SKILL_SOURCES, ...state.sources]
    },
    async getSource(id) {
      const always = ALWAYS_PRESENT_SKILL_SOURCES.find((source) => source.id === id)
      if (always) return always
      const state = await read()
      return state.sources.find((source) => source.id === id) ?? null
    },
    async putSource(source, scan) {
      await update((state) => {
        const index = state.sources.findIndex((existing) => existing.id === source.id)
        if (index === -1) state.sources.push(source)
        else state.sources[index] = source
        if (scan) state.scans[source.id] = scan
        else delete state.scans[source.id]
        return true
      })
    },
    async removeSource(id) {
      if (!isRemovableSkillSource(id)) return false
      return update((state) => {
        const index = state.sources.findIndex((source) => source.id === id)
        if (index === -1) return false
        state.sources.splice(index, 1)
        delete state.scans[id]
        return true
      })
    },
    async getScan(id) {
      const state = await read()
      return state.scans[id] ?? null
    },
    async hasAdoptedLegacyPacks() {
      return (await read()).adoptedLegacyPacks
    },
    async markLegacyPacksAdopted() {
      await update((state) => {
        if (state.adoptedLegacyPacks) return false
        state.adoptedLegacyPacks = true
        return true
      })
    },
  }
}

/**
 * A malformed or partly-unreadable store degrades to "no user sources" rather
 * than throwing: the always-present sources still list, and re-adding a
 * repository is one paste.
 */
export function parseSkillSourceState(raw: string): PersistedState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }
  if (!parsed || typeof parsed !== 'object') return emptyState()
  const record = parsed as { sources?: unknown; scans?: unknown; adoptedLegacyPacks?: unknown }
  const sources = Array.isArray(record.sources)
    ? record.sources.filter(isPersistableSource).filter((source) => isRemovableSkillSource(source.id))
    : []
  // A scan is only ever a cache of a source in the list beside it, so a key
  // naming a source this read dropped is dead weight that the next write would
  // persist again — a scan of a repository nobody can open, growing by one
  // every time a malformed source is filtered out.
  const known = new Set(sources.map((source) => source.id))
  const scans: Record<string, ScanResult> = {}
  if (record.scans && typeof record.scans === 'object' && !Array.isArray(record.scans)) {
    for (const [id, scan] of Object.entries(record.scans as Record<string, unknown>)) {
      if (known.has(id) && isPersistableScan(scan)) scans[id] = scan
    }
  }
  return { sources, scans, adoptedLegacyPacks: record.adoptedLegacyPacks === true }
}

function emptyState(): PersistedState {
  return { sources: [], scans: {}, adoptedLegacyPacks: false }
}

/**
 * What a stored source has to be to survive a read. The two bundled sources
 * never appear here (they are always-present and filtered out by id), so this
 * covers the kinds a person can ADD: a repository, and — since the source-tabs
 * ruling (2026-09-05) — a folder on this machine, which is identified by its
 * path rather than by a repository and so must carry one.
 *
 * The kind check is not decoration: a source that fails it is dropped on the
 * very next read, which is how a folder added successfully vanished before it
 * could be opened.
 */
function isPersistableSource(value: unknown): value is SkillSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0) return false
  if (typeof source.name !== 'string') return false
  if (source.kind === 'github') return typeof source.repo === 'string'
  if (source.kind === 'local') return typeof source.path === 'string' && source.path.length > 0
  return false
}

function isPersistableScan(value: unknown): value is ScanResult {
  if (!value || typeof value !== 'object') return false
  const scan = value as Record<string, unknown>
  return Array.isArray(scan.skills) && Array.isArray(scan.groups)
}
