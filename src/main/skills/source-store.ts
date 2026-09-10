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
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
  OFFICIAL_PLUGINS_SKILL_SOURCE_REPO,
  STUDIO_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_NAME,
  STUDIO_SKILL_SOURCE_REPO,
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
 *
 * The studio-marketplace ruling (2026-09-06) made ours the same shape. It used
 * to be a `builtin` folder scan of `resources/skills` under Skills and the
 * signed registry under Plugins — one tab, two backends, and our own plugin
 * with no home in either. It is now `sprintengine/studio-releases`, a
 * Claude-format marketplace we publish, read exactly like Anthropic's. What is
 * bundled is a SEED of it (see `studioMarketplaceSeedRoot` in index.ts), so the
 * tab lists offline and the remote copy wins whenever it can be reached.
 */
const ALWAYS_PRESENT_SKILL_SOURCES: readonly SkillSource[] = [
  {
    id: STUDIO_SKILL_SOURCE_ID,
    kind: 'github',
    name: STUDIO_SKILL_SOURCE_NAME,
    repo: STUDIO_SKILL_SOURCE_REPO,
    monogram: 'SS',
    blurb: 'The plugin and the skills SprintEngine Studio ships.',
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
 * Both always-present sources are repositories since the frozen-snapshots
 * retirement (2026-09-06), so this is now a `kind` check with nothing else to
 * exclude — the bundled Connectors source, which had no commit and no network
 * and was re-read from disk each launch, is gone.
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
 * ("claude-plugins-official", "studio-releases"), and these sources are called
 * Anthropic and SprintEngine Studio.
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

export type PersistedState = {
  sources: SkillSource[]
  scans: Record<string, ScanResult>
}

/**
 * One line per thing that happened to the store.
 *
 * A source a person added went missing and there was no way to tell whether it
 * had been dropped on a read, overwritten by a write, or never stored at all —
 * every path here was silent. So the store now says what it did: what it
 * dropped and why, what it wrote, what it removed. Terse on purpose; this runs
 * on every launch and on every hourly update check.
 */
export type SkillSourceLog = (event: string, detail: Record<string, unknown>) => void

/** Events that are a problem rather than a note. */
const WARNING_EVENTS = new Set(['source-dropped', 'scan-dropped', 'store-unreadable', 'store-quarantined'])

export const skillSourceLog: SkillSourceLog = (event, detail) => {
  const write = WARNING_EVENTS.has(event) ? console.warn : console.info
  write(`[skill-sources] ${event}`, detail)
}

export type SkillSourceStoreOptions = {
  /** Injected in tests; production writes to the main-process console. */
  log?: SkillSourceLog
}

export type SkillSourceStore = {
  listSources(): Promise<SkillSource[]>
  getSource(id: string): Promise<SkillSource | null>
  /** A null scan records the source without claiming to know what it holds. */
  putSource(source: SkillSource, scan: ScanResult | null): Promise<void>
  removeSource(id: string): Promise<boolean>
  getScan(id: string): Promise<ScanResult | null>
}

export function createSkillSourceStore(userDataDir: string, options: SkillSourceStoreOptions = {}): SkillSourceStore {
  const path = join(userDataDir, FILE_NAME)
  const log = options.log ?? skillSourceLog

  /** The bytes on disk, or null when there is no store yet. Anything else throws. */
  const readBytes = async (): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Reading to ANSWER. A store that cannot be read degrades to "no user
   * sources" rather than throwing — the always-present sources still list —
   * but it says so now instead of looking like an empty list.
   */
  const read = async (): Promise<PersistedState> => {
    try {
      const raw = await readBytes()
      return raw === null ? emptyState() : parseSkillSourceBytes(raw, log).state
    } catch (error) {
      log('store-unreadable', { path, message: errorMessage(error) })
      return emptyState()
    }
  }

  /**
   * Reading to WRITE, which is a different question.
   *
   * The old read swallowed every error and handed back an empty state, so a
   * store that could not be read for a moment — a permission error, a busy or
   * unmounted volume, EMFILE under load — became an empty store the very next
   * write persisted over the top of. That is a whole list of added sources lost
   * to one transient failure, silently. An unreadable store now aborts the
   * write instead: the add reports a failure the person can act on, and the
   * file is still there.
   *
   * Bytes that are present but not JSON are the one case that must not block
   * forever — a store nobody can parse would otherwise refuse every add for the
   * life of the install — so they are kept aside under a timestamped name and
   * the write proceeds over a fresh state.
   */
  const readForWrite = async (): Promise<PersistedState> => {
    const raw = await readBytes()
    if (raw === null) return emptyState()
    const { state, unparsable } = parseSkillSourceBytes(raw, log)
    if (unparsable && raw.trim().length > 0) {
      const kept = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      await rename(path, kept).catch(() => undefined)
      log('store-quarantined', { path, kept, bytes: raw.length })
    }
    return state
  }

  // Serialized read-modify-write: adding two sources in quick succession must
  // not lose one to a stale in-memory copy.
  let writeChain: Promise<unknown> = Promise.resolve()
  const update = async (mutate: (state: PersistedState) => boolean): Promise<boolean> => {
    const run = writeChain.then(async () => {
      const state = await readForWrite()
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
      let added = false
      try {
        await update((state) => {
          const index = state.sources.findIndex((existing) => existing.id === source.id)
          added = index === -1
          if (index === -1) state.sources.push(source)
          else state.sources[index] = source
          if (scan) state.scans[source.id] = scan
          else delete state.scans[source.id]
          return true
        })
      } catch (error) {
        log('source-write-failed', { id: source.id, message: errorMessage(error) })
        throw error
      }
      log('source-written', { id: source.id, outcome: added ? 'added' : 'updated', skills: scan?.skills.length ?? null })
    },
    async removeSource(id) {
      if (!isRemovableSkillSource(id)) {
        log('source-removed', { id, outcome: 'refused-always-present' })
        return false
      }
      const removed = await update((state) => {
        const index = state.sources.findIndex((source) => source.id === id)
        if (index === -1) return false
        state.sources.splice(index, 1)
        delete state.scans[id]
        return true
      })
      log('source-removed', { id, outcome: removed ? 'removed' : 'not-in-list' })
      return removed
    },
    async getScan(id) {
      const state = await read()
      return state.scans[id] ?? null
    },
  }
}

/**
 * A malformed or partly-unreadable store degrades to "no user sources" rather
 * than throwing: the always-present sources still list, and re-adding a
 * repository is one paste.
 */
export function parseSkillSourceState(raw: string, log: SkillSourceLog = skillSourceLog): PersistedState {
  return parseSkillSourceBytes(raw, log).state
}

/**
 * The parse, plus whether the bytes were JSON at all — which only a caller
 * about to WRITE needs, to tell "there was nothing here" from "there was
 * something here and it is now unreadable". The store's own write path asks
 * it, and so does the legacy-profile rescue before it writes over the current
 * store (`legacy-profile.ts`).
 */
export function parseSkillSourceBytes(
  raw: string,
  log: SkillSourceLog,
): { state: PersistedState; unparsable: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log('store-unreadable', { reason: 'invalid-json', bytes: raw.length, message: errorMessage(error) })
    return { state: emptyState(), unparsable: true }
  }
  if (!parsed || typeof parsed !== 'object') {
    log('store-unreadable', { reason: 'not-an-object', bytes: raw.length })
    return { state: emptyState(), unparsable: true }
  }
  const record = parsed as { sources?: unknown; scans?: unknown }
  const sources: SkillSource[] = []
  if (Array.isArray(record.sources)) {
    for (const candidate of record.sources) {
      // Every drop is named. A stored source that fails this filter used to
      // disappear without a word, which is how a folder source and (we
      // suspect) a repository source went missing with nothing in any log to
      // say so.
      const reason = sourceDropReason(candidate)
      if (reason) {
        log('source-dropped', { id: describeSourceId(candidate), reason })
        continue
      }
      const source = candidate as SkillSource
      if (!isRemovableSkillSource(source.id) && !isCachedAlwaysPresentSource(source)) {
        log('source-dropped', { id: source.id, reason: 'always-present-id-with-another-shape' })
        continue
      }
      sources.push(source)
    }
  } else if (record.sources !== undefined) {
    log('store-unreadable', { reason: 'sources-not-an-array' })
  }
  // A scan is only ever a cache of a source in the list beside it, so a key
  // naming a source this read dropped is dead weight that the next write would
  // persist again — a scan of a repository nobody can open, growing by one
  // every time a malformed source is filtered out.
  const known = new Set(sources.map((source) => source.id))
  const scans: Record<string, ScanResult> = {}
  if (record.scans && typeof record.scans === 'object' && !Array.isArray(record.scans)) {
    for (const [id, scan] of Object.entries(record.scans as Record<string, unknown>)) {
      if (!known.has(id)) {
        log('scan-dropped', { id, reason: 'no-source-in-list' })
        continue
      }
      if (!isPersistableScan(scan)) {
        log('scan-dropped', { id, reason: 'malformed' })
        continue
      }
      // A seed scan is never written here on purpose (see `putSource`'s caller
      // in index.ts), and if one ever were, wearing the flag on the way back
      // out would make a cache read look like a bundled read forever. The
      // stored copy is a read of something, so the flag is dropped rather than
      // trusted.
      const { bundled: _bundled, ...cached } = scan
      scans[id] = cached
    }
  } else if (record.scans !== undefined) {
    log('store-unreadable', { reason: 'scans-not-an-object' })
  }
  return { state: { sources, scans }, unparsable: false }
}

function emptyState(): PersistedState {
  return { sources: [], scans: {} }
}

/**
 * What a stored source has to be to survive a read. The bundled-with-the-app
 * source never appears here (it is always-present and filtered out by id; the
 * always-present REPOSITORIES do appear, carrying their scan state), so this
 * covers the kinds a person can ADD: a repository, and — since the source-tabs
 * ruling (2026-09-05) — a folder on this machine, which is identified by its
 * path rather than by a repository and so must carry one.
 *
 * The kind check is not decoration: a source that fails it is dropped on the
 * very next read, which is how a folder added successfully vanished before it
 * could be opened. It returns the REASON rather than a boolean so the drop can
 * be logged with something a person can act on.
 */
function sourceDropReason(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not-an-object'
  const source = value as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0) return 'no-id'
  if (typeof source.name !== 'string') return 'no-name'
  if (source.kind === 'github') return typeof source.repo === 'string' ? null : 'github-source-without-a-repo'
  if (source.kind === 'local') {
    return typeof source.path === 'string' && source.path.length > 0 ? null : 'folder-source-without-a-path'
  }
  return `unknown-kind:${typeof source.kind === 'string' ? source.kind : typeof source.kind}`
}

/** Enough of an unusable record to find it in the file by hand. */
function describeSourceId(value: unknown): string {
  if (!value || typeof value !== 'object') return '(not an object)'
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : '(no id)'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPersistableScan(value: unknown): value is ScanResult {
  if (!value || typeof value !== 'object') return false
  const scan = value as Record<string, unknown>
  return Array.isArray(scan.skills) && Array.isArray(scan.groups)
}
