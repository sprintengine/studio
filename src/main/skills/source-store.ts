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
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
  OFFICIAL_PLUGINS_SKILL_SOURCE_REPO,
  type ScanResult,
  type SkillSource,
} from '../../shared/skills'

const FILE_NAME = 'skill-sources.json'

/**
 * The sources every install has, which cannot be removed, in the order the
 * catalogues show them.
 *
 * The official-plugins ruling (2026-09-06) put Claude Code's own marketplace
 * here: the app never fetched `anthropics/claude-plugins-official`, yet 254 of
 * the 256 skills-only entries in the frozen registry were that repository's
 * plugins by name. It is a repository like any the user adds — it is read over
 * the network, it carries a commit, Sync re-reads it — and it differs only in
 * that it is present before anyone adds it and cannot be taken away.
 */
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
    id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
    kind: 'github',
    name: OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
    repo: OFFICIAL_PLUGINS_SKILL_SOURCE_REPO,
    monogram: 'AN',
    blurb: 'Claude Code’s official plugin marketplace.',
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

/**
 * An always-present source whose contents are READ rather than shipped. Its
 * scan is a network round trip and its commit is the answer to "has this moved
 * since", so both have to survive to disk exactly like an added repository's —
 * a store that dropped them would refetch 292 plugins on every launch and could
 * never say an update was available.
 *
 * The two bundled-with-the-app sources are the opposite: no commit, no network,
 * re-read from disk each launch, so nothing about them is worth persisting and
 * a stored copy would only be a stale name waiting to overrule this build's.
 */
function isCachedAlwaysPresentSource(stored: SkillSource): boolean {
  return ALWAYS_PRESENT_SKILL_SOURCES.some(
    // The STORED record's kind has to match too, not just this build's. A
    // record filed under the always-present id with some other kind — a hand
    // edit, or a store written by a build that placed a different source
    // there — used to survive this filter and then hand its fields to
    // `withPersistedScanState`, which trusted them.
    (always) => always.id === stored.id && always.kind === 'github' && stored.kind === always.kind
  )
}

/**
 * An always-present source, wearing whatever a scan of it wrote down. Identity
 * — name, repository, monogram, blurb — is this build's and is never overruled
 * by the persisted copy: `scanGithubSource` names a source after its repository
 * ("claude-plugins-official"), and this source is called Anthropic.
 */
function withPersistedScanState(always: SkillSource, stored: SkillSource | undefined): SkillSource {
  // Each field is checked rather than copied: `isPersistableSource` validates
  // an id, a name and a kind, and nothing else, so every one of these four
  // arrives as `unknown` wearing a type. A `commitSha` of undefined reaches a
  // plugin's "Open on GitHub" as `/tree/undefined/…`.
  if (!stored || stored.kind !== always.kind) return always
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    ...always,
    commitSha: text(stored.commitSha),
    scannedAt: text(stored.scannedAt),
    ...(typeof stored.headSha === 'string' ? { headSha: stored.headSha } : {}),
    ...(typeof stored.headCheckedAt === 'string' ? { headCheckedAt: stored.headCheckedAt } : {}),
  }
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
      const stored = new Map(state.sources.map((source) => [source.id, source]))
      return [
        ...ALWAYS_PRESENT_SKILL_SOURCES.map((source) => withPersistedScanState(source, stored.get(source.id))),
        // An always-present source's stored copy is its scan state, not a
        // second source: listing it again would be the same repository under
        // two tabs, one of them removable.
        ...state.sources.filter((source) => isRemovableSkillSource(source.id)),
      ]
    },
    async getSource(id) {
      const always = ALWAYS_PRESENT_SKILL_SOURCES.find((source) => source.id === id)
      const state = await read()
      const stored = state.sources.find((source) => source.id === id)
      if (always) return withPersistedScanState(always, stored)
      return stored ?? null
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
    ? record.sources
        .filter(isPersistableSource)
        .filter((source) => isRemovableSkillSource(source.id) || isCachedAlwaysPresentSource(source))
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
 * What a stored source has to be to survive a read. The two bundled-with-the-app
 * sources never appear here (they are always-present and filtered out by id;
 * the always-present REPOSITORY does appear, carrying its scan state), so this
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
