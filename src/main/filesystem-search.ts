import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { stat } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import { rgPath } from '@vscode/ripgrep'
import type { ContentSearchEntry, ContentSearchResult, FileSearchEntry, FileSearchResult } from '../shared/electron-api'
import { watchEventPaths } from '../shared/file-watch-event'
import { getWatchHub, type WatchHub, type WatchSubscription } from './workspace-watch-hub'

export type FileSearchRequest = {
  rootPath: string
  query: string
  limit?: number
}

export type ContentSearchRequest = FileSearchRequest

type FileSearchEngineResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

type ContentSearchEngineResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

const FILE_SEARCH_DEFAULT_LIMIT = 200
const FILE_SEARCH_MAX_LIMIT = 500
const CONTENT_SEARCH_DEFAULT_LIMIT = 200
const CONTENT_SEARCH_MAX_LIMIT = 500
const FILE_SEARCH_DEFAULT_EXCLUDES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'coverage',
]

const activeFileSearches = new Map<number, ChildProcessWithoutNullStreams>()
const cancelledFileSearches = new WeakSet<ChildProcessWithoutNullStreams>()
const activeContentSearches = new Map<number, ChildProcessWithoutNullStreams>()
const cancelledContentSearches = new WeakSet<ChildProcessWithoutNullStreams>()

function normalizeFileSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return FILE_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), FILE_SEARCH_MAX_LIMIT)
}

function normalizeContentSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CONTENT_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), CONTENT_SEARCH_MAX_LIMIT)
}

function normalizeSearchPath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function builtinExcludeArgs(): string[] {
  return FILE_SEARCH_DEFAULT_EXCLUDES.flatMap((pattern) => ['-g', `!**/${pattern}/**`])
}

function toFileSearchEntry(rootPath: string, relativePath: string): FileSearchEntry {
  const normalizedRelativePath = relativePath.replace(/\\/g, sep)
  const fullPath = join(rootPath, normalizedRelativePath)
  const parentRelativePath = dirname(normalizedRelativePath)
  return {
    name: basename(fullPath),
    path: fullPath,
    parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
    isDir: false,
  }
}

function sortFileSearchResults(results: FileSearchEntry[], query: string): FileSearchEntry[] {
  const normalizedQuery = normalizeSearchPath(query)
  return [...results].sort((a, b) => {
    const aName = normalizeSearchPath(a.name)
    const bName = normalizeSearchPath(b.name)
    const aNameIndex = aName.indexOf(normalizedQuery)
    const bNameIndex = bName.indexOf(normalizedQuery)
    const aPath = normalizeSearchPath(a.path)
    const bPath = normalizeSearchPath(b.path)
    const aScore = aNameIndex === -1 ? 10_000 + aPath.indexOf(normalizedQuery) : aNameIndex
    const bScore = bNameIndex === -1 ? 10_000 + bPath.indexOf(normalizedQuery) : bNameIndex
    return aScore - bScore || a.path.length - b.path.length || a.path.localeCompare(b.path)
  })
}

function cancelActiveFileSearch(senderId: number): void {
  const activeSearch = activeFileSearches.get(senderId)
  if (!activeSearch) return
  activeFileSearches.delete(senderId)
  cancelledFileSearches.add(activeSearch)
  try {
    activeSearch.kill()
  } catch {
    // Process may already be exiting.
  }
}

export function cancelActiveContentSearch(senderId: number): void {
  const activeSearch = activeContentSearches.get(senderId)
  if (!activeSearch) return
  activeContentSearches.delete(senderId)
  cancelledContentSearches.add(activeSearch)
  try {
    activeSearch.kill()
  } catch {
    // Process may already be exiting.
  }
}

async function searchFilesWithRipgrep(
  senderId: number,
  rootPath: string,
  query: string,
  limit: number,
): Promise<FileSearchEngineResult> {
  const normalizedQuery = normalizeSearchPath(query)
  const results: FileSearchEntry[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let truncated = false
  const excludeArgs = builtinExcludeArgs()

  return new Promise<FileSearchEngineResult>((resolve) => {
    let settled = false
    const child = spawn(rgPath, ['--files', '--color', 'never', '--no-messages', ...excludeArgs], {
      cwd: rootPath,
      windowsHide: true,
    })

    activeFileSearches.set(senderId, child)

    const finish = (result: FileSearchEngineResult) => {
      if (settled) return
      settled = true
      if (activeFileSearches.get(senderId) === child) {
        activeFileSearches.delete(senderId)
      }
      resolve(result)
    }

    const consumeLine = (relativePath: string) => {
      if (!relativePath) return
      if (!normalizeSearchPath(relativePath).includes(normalizedQuery)) return
      results.push(toFileSearchEntry(rootPath, relativePath))
      if (results.length > limit) {
        truncated = true
        results.length = limit
        finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' })
        try {
          child.kill()
        } catch {
          // Process may already have exited after producing enough results.
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/u)
      stdoutBuffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
    })

    child.on('error', (error) => {
      if (cancelledFileSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        engine: 'ripgrep',
      })
    })

    child.on('close', (code) => {
      if (settled) return
      if (cancelledFileSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }
      if (stdoutBuffer) consumeLine(stdoutBuffer)
      if (settled) return
      if (code === 0 || code === 1) {
        finish({ ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
        engine: 'ripgrep',
      })
    })
  })
}

function withFileSearchDiagnostics(result: FileSearchEngineResult, startedAt: number): FileSearchResult {
  if (!result.ok) return result
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
    resultCount: result.results.length,
  }
}

function toContentSearchEntry(rootPath: string, message: unknown): ContentSearchEntry | null {
  if (!message || typeof message !== 'object') return null
  const envelope = message as {
    type?: unknown
    data?: {
      path?: { text?: unknown }
      lines?: { text?: unknown }
      line_number?: unknown
      submatches?: Array<{
        start?: unknown
        match?: { text?: unknown }
      }>
    }
  }

  if (envelope.type !== 'match') return null
  const relativePath =
    typeof envelope.data?.path?.text === 'string' ? envelope.data.path.text.replace(/^\.[\\/]/u, '') : ''
  const lineText = typeof envelope.data?.lines?.text === 'string' ? envelope.data.lines.text.replace(/\r?\n$/u, '') : ''
  const lineNumber = typeof envelope.data?.line_number === 'number' ? envelope.data.line_number : 0
  const firstMatch = envelope.data?.submatches?.[0]
  const column = typeof firstMatch?.start === 'number' ? firstMatch.start + 1 : 1
  const matchText = typeof firstMatch?.match?.text === 'string' ? firstMatch.match.text : ''

  if (!relativePath || lineNumber < 1) return null

  const normalizedRelativePath = relativePath.replace(/\\/g, sep)
  const fullPath = join(rootPath, normalizedRelativePath)
  const parentRelativePath = dirname(normalizedRelativePath)
  return {
    name: basename(fullPath),
    path: fullPath,
    parentPath: parentRelativePath === '.' ? rootPath : join(rootPath, parentRelativePath),
    lineNumber,
    column,
    lineText,
    matchText,
  }
}

async function searchContentWithRipgrep(
  senderId: number,
  rootPath: string,
  query: string,
  limit: number,
): Promise<ContentSearchEngineResult> {
  const results: ContentSearchEntry[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let truncated = false

  return new Promise<ContentSearchEngineResult>((resolve) => {
    let settled = false
    const child = spawn(
      rgPath,
      [
        '--json',
        '--color',
        'never',
        '--no-messages',
        '--line-number',
        '--column',
        '--fixed-strings',
        ...builtinExcludeArgs(),
        '--',
        query,
        '.',
      ],
      {
        cwd: rootPath,
        windowsHide: true,
      },
    )

    activeContentSearches.set(senderId, child)

    const finish = (result: ContentSearchEngineResult) => {
      if (settled) return
      settled = true
      if (activeContentSearches.get(senderId) === child) {
        activeContentSearches.delete(senderId)
      }
      resolve(result)
    }

    const consumeLine = (line: string) => {
      if (!line) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }

      const entry = toContentSearchEntry(rootPath, message)
      if (!entry) return
      results.push(entry)
      if (results.length > limit) {
        truncated = true
        results.length = limit
        finish({ ok: true, results, truncated, engine: 'ripgrep' })
        try {
          child.kill()
        } catch {
          // Process may already have exited after producing enough results.
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/u)
      stdoutBuffer = lines.pop() ?? ''
      lines.forEach(consumeLine)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
    })

    child.on('error', (error) => {
      if (cancelledContentSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        engine: 'ripgrep',
      })
    })

    child.on('close', (code) => {
      if (settled) return
      if (cancelledContentSearches.has(child)) {
        finish({ ok: true, results: [], truncated: false, engine: 'ripgrep' })
        return
      }
      if (stdoutBuffer) consumeLine(stdoutBuffer)
      if (settled) return
      if (code === 0 || code === 1) {
        finish({ ok: true, results, truncated, engine: 'ripgrep' })
        return
      }

      finish({
        ok: false,
        message: stderrBuffer.trim() || `ripgrep exited with code ${code ?? 'unknown'}.`,
        engine: 'ripgrep',
      })
    })
  })
}

function withContentSearchDiagnostics(result: ContentSearchEngineResult, startedAt: number): ContentSearchResult {
  if (!result.ok) return result
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
    resultCount: result.results.length,
  }
}

export async function searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult> {
  const startedAt = Date.now()
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath : ''
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const limit = normalizeFileSearchLimit(input.limit)
  if (!rootPath || !query) {
    return withFileSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt)
  }

  try {
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) {
      return { ok: false, message: 'Search root is not a directory.', engine: null }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      engine: null,
    }
  }

  cancelActiveFileSearch(senderId)
  const ticket = (fileSearchTickets.get(senderId) ?? 0) + 1
  fileSearchTickets.set(senderId, ticket)

  const listing = await fileListCache.list(rootPath)
  if (listing) {
    // A newer query from the same window arrived while the list was being
    // built: answer this one empty, exactly as a cancelled walk used to.
    if (fileSearchTickets.get(senderId) !== ticket) {
      return withFileSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt)
    }
    return withFileSearchDiagnostics(filterFileList(rootPath, listing, query, limit), startedAt)
  }

  // Too large to hold, or the listing failed: walk for this query alone.
  const ripgrepResult = await searchFilesWithRipgrep(senderId, rootPath, query, limit)
  if (ripgrepResult.ok) return withFileSearchDiagnostics(ripgrepResult, startedAt)
  return ripgrepResult
}

const fileSearchTickets = new Map<number, number>()

/** The same match and ranking the streaming walk applies, over a held list. */
export function filterFileList(
  rootPath: string,
  files: readonly string[],
  query: string,
  limit: number,
): FileSearchEngineResult & { ok: true } {
  const normalizedQuery = normalizeSearchPath(query)
  const results: FileSearchEntry[] = []
  let truncated = false
  for (const relativePath of files) {
    if (!normalizeSearchPath(relativePath).includes(normalizedQuery)) continue
    if (results.length === limit) {
      truncated = true
      break
    }
    results.push(toFileSearchEntry(rootPath, relativePath))
  }
  return { ok: true, results: sortFileSearchResults(results, query), truncated, engine: 'ripgrep' }
}

/**
 * The quick-open file list, per root, held between keystrokes.
 *
 * Quick-open used to start `rg --files` over the whole repository on every
 * query, so typing a twelve-character name walked the tree twelve times. The
 * list is now walked once and filtered in memory, and thrown away when the
 * tree changes shape: the shared watcher (workspace-watch-hub.ts) reports a
 * create, delete or rename, or an edit to an ignore file, which changes what
 * `rg` would list. An edit to a file's contents changes nothing here and keeps
 * the list.
 *
 * Bounds, because the watcher is not the whole story:
 * - an entry is also dropped after `maxAgeMs`, as a backstop for a platform
 *   whose watch is not recursive (Linux) or a root that cannot be watched;
 * - a root nobody has searched for `idleMs` is dropped and its watch closed;
 * - a listing past `maxFiles` paths is not held at all, and that root keeps
 *   the per-query walk, which stops early at the result limit. That verdict is
 *   remembered for the root (until `maxAgeMs`, or an ignore-file edit that may
 *   shrink the list), so a keystroke does not start a 200,000-path listing
 *   only to throw it away before its own walk.
 */
type CachedFileList = {
  files: string[] | null
  building: Promise<string[] | null> | null
  builtAt: number
  /** When the listing last came back too large to hold; null when it did not. */
  tooLargeAt: number | null
  lastUsedAt: number
  generation: number
  watch: WatchSubscription | null
  idleTimer: NodeJS.Timeout | null
}

/** What `listFiles` answers for a root with more than `maxFiles` paths. */
export const FILE_LIST_TOO_LARGE = 'too-large' as const

const FILE_LIST_MAX_FILES = 200_000
const FILE_LIST_MAX_AGE_MS = 5 * 60_000
const FILE_LIST_IDLE_MS = 10 * 60_000
const IGNORE_FILE_NAMES = new Set(['.gitignore', '.ignore', '.rgignore'])

export function createFileListCache(
  deps: {
    listFiles?: (rootPath: string, maxFiles: number) => Promise<string[] | typeof FILE_LIST_TOO_LARGE | null>
    hub?: () => WatchHub
    now?: () => number
    maxAgeMs?: number
    idleMs?: number
  } = {},
) {
  const listFiles = deps.listFiles ?? listFilesWithRipgrep
  const hub = deps.hub ?? getWatchHub
  const now = deps.now ?? Date.now
  const maxAgeMs = deps.maxAgeMs ?? FILE_LIST_MAX_AGE_MS
  const idleMs = deps.idleMs ?? FILE_LIST_IDLE_MS
  const entries = new Map<string, CachedFileList>()

  const drop = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    entry.watch?.close()
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entries.delete(key)
  }

  const invalidate = (entry: CachedFileList): void => {
    entry.files = null
    entry.generation += 1
  }

  const touch = (key: string, entry: CachedFileList): void => {
    entry.lastUsedAt = now()
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => drop(key), idleMs)
    entry.idleTimer.unref?.()
  }

  const open = (rootPath: string): CachedFileList => {
    const entry: CachedFileList = {
      files: null,
      building: null,
      builtAt: 0,
      tooLargeAt: null,
      lastUsedAt: now(),
      generation: 0,
      watch: null,
      idleTimer: null,
    }
    try {
      entry.watch = hub().subscribe(rootPath, (event) => {
        const paths = watchEventPaths(event)
        const ignoreFileEdited = paths !== null && paths.some((path) => IGNORE_FILE_NAMES.has(basename(path)))
        const reshaped = paths === null || event.eventType === 'rename' || ignoreFileEdited
        if (reshaped) invalidate(entry)
        // A file created or removed hardly moves a count past 200,000; an
        // ignore file can halve it.
        if (ignoreFileEdited) entry.tooLargeAt = null
      })
    } catch {
      // Unwatchable (a network mount): the age bound alone keeps it honest.
    }
    return entry
  }

  return {
    async list(rootPath: string): Promise<string[] | null> {
      const key = normalizeSearchPath(rootPath).replace(/\/+$/u, '')
      let entry = entries.get(key)
      if (!entry) {
        entry = open(rootPath)
        entries.set(key, entry)
      }
      touch(key, entry)
      if (entry.files && now() - entry.builtAt < maxAgeMs) return entry.files
      if (entry.tooLargeAt !== null && now() - entry.tooLargeAt < maxAgeMs) return null
      if (entry.building) return entry.building

      const generation = entry.generation
      const current = entry
      current.building = listFiles(rootPath, FILE_LIST_MAX_FILES)
        .catch(() => null)
        .then((listed) => {
          current.building = null
          if (listed === FILE_LIST_TOO_LARGE) {
            current.tooLargeAt = now()
            return null
          }
          const files = listed
          current.tooLargeAt = null
          // The tree changed shape while it was being walked: answer this
          // query from the walk, but do not keep it.
          if (files && current.generation === generation) {
            current.files = files
            current.builtAt = now()
          }
          return files
        })
      return current.building
    },
    size: () => entries.size,
    clear(): void {
      for (const key of [...entries.keys()]) drop(key)
    },
  }
}

const fileListCache = createFileListCache()

/**
 * Every file `rg` would list under `rootPath`, root-relative; `too-large` when
 * the walk passed `maxFiles` (it is stopped there rather than finished); null
 * when it failed.
 */
function listFilesWithRipgrep(
  rootPath: string,
  maxFiles: number,
): Promise<string[] | typeof FILE_LIST_TOO_LARGE | null> {
  return new Promise((resolve) => {
    const files: string[] = []
    let buffered = ''
    let settled = false
    const finish = (value: string[] | typeof FILE_LIST_TOO_LARGE | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn(rgPath, ['--files', '--color', 'never', '--no-messages', ...builtinExcludeArgs()], {
      cwd: rootPath,
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      buffered += chunk
      const lines = buffered.split(/\r?\n/u)
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line) files.push(line)
      if (files.length > maxFiles) {
        finish(FILE_LIST_TOO_LARGE)
        try {
          child.kill()
        } catch {
          // Already exiting.
        }
      }
    })
    child.stderr.resume()
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (buffered) files.push(buffered)
      finish(code === 0 || code === 1 ? files : null)
    })
  })
}

export async function searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult> {
  const startedAt = Date.now()
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath : ''
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const limit = normalizeContentSearchLimit(input.limit)
  if (!rootPath || !query) {
    return withContentSearchDiagnostics({ ok: true, results: [], truncated: false, engine: 'ripgrep' }, startedAt)
  }

  try {
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) {
      return { ok: false, message: 'Search root is not a directory.', engine: null }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      engine: null,
    }
  }

  cancelActiveContentSearch(senderId)
  return withContentSearchDiagnostics(await searchContentWithRipgrep(senderId, rootPath, query, limit), startedAt)
}
