import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { stat } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import { rgPath } from '@vscode/ripgrep'
import type { ContentSearchEntry, ContentSearchResult, FileSearchEntry, FileSearchResult } from '../shared/electron-api'

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
  const ripgrepResult = await searchFilesWithRipgrep(senderId, rootPath, query, limit)
  if (ripgrepResult.ok) return withFileSearchDiagnostics(ripgrepResult, startedAt)
  return ripgrepResult
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
