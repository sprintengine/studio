import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { openFileSurface } from '../../utils/openFileSurface'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { InboxRow, Skeleton } from '../ui'

interface Props {
  workspaceId: string
}

type ContentSearchDiagnostics = {
  engine: 'ripgrep'
  elapsedMs: number
  resultCount: number
  truncated: boolean
}

const CONTENT_SEARCH_LIMIT = 200
const CONTENT_SEARCH_DEBOUNCE_MS = 260

function relativePath(rootPath: string, filePath: string): string {
  const root = rootPath.replace(/[\\/]+$/u, '')
  if (!filePath.toLowerCase().startsWith(root.toLowerCase())) return filePath
  return filePath.slice(root.length).replace(/^[\\/]+/u, '')
}

function highlightLine(lineText: string, matchText: string) {
  if (!matchText) return lineText
  const index = lineText.toLowerCase().indexOf(matchText.toLowerCase())
  if (index === -1) return lineText

  return (
    <>
      {lineText.slice(0, index)}
      <mark className="rounded-sm bg-[color:var(--tone-warn-soft)] px-0.5 text-[color:var(--tone-warn)]">{lineText.slice(index, index + matchText.length)}</mark>
      {lineText.slice(index + matchText.length)}
    </>
  )
}

export default function ContentSearchPanel({ workspaceId }: Props) {
  const { folderReadyPath, folderMissing, checkingFolder } = useWorkspaceFolderStatus(workspaceId)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? [])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContentSearchEntry[]>([])
  const [diagnostics, setDiagnostics] = useState<ContentSearchDiagnostics | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestSeqRef = useRef(0)

  const trimmedQuery = query.trim()
  const statusText = useMemo(() => {
    if (!folderReadyPath) return null
    if (searching) return 'Searching...'
    if (error) return error
    if (!trimmedQuery) return null
    if (!diagnostics) return null
    const suffix = diagnostics.truncated ? '+' : ''
    return `${diagnostics.resultCount}${suffix} result${diagnostics.resultCount === 1 ? '' : 's'} in ${diagnostics.elapsedMs} ms`
  }, [diagnostics, error, folderReadyPath, searching, trimmedQuery])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!folderReadyPath || !trimmedQuery) {
      requestSeqRef.current += 1
      setResults([])
      setDiagnostics(null)
      setSearching(false)
      setError(null)
      return
    }

    const requestSeq = ++requestSeqRef.current
    setSearching(true)
    setError(null)
    let searchStarted = false

    const timeout = window.setTimeout(() => {
      searchStarted = true
      window.api.searchContent(folderReadyPath, trimmedQuery, {
        limit: CONTENT_SEARCH_LIMIT,
        excludes: searchExcludes,
      })
        .then((result) => {
          if (requestSeq !== requestSeqRef.current) return
          if (!result.ok) {
            setResults([])
            setDiagnostics(null)
            setError(result.message)
            return
          }

          setResults(result.results)
          setDiagnostics({
            engine: result.engine,
            elapsedMs: result.elapsedMs,
            resultCount: result.resultCount,
            truncated: result.truncated,
          })

          logPerfEvent('ContentSearch', 'search-content', {
            rootPath: folderReadyPath,
            query: trimmedQuery,
            engine: result.engine,
            elapsedMs: result.elapsedMs,
            resultCount: result.resultCount,
            truncated: result.truncated,
          })
        })
        .catch((searchError) => {
          if (requestSeq !== requestSeqRef.current) return
          setResults([])
          setDiagnostics(null)
          setError(searchError instanceof Error ? searchError.message : String(searchError))
        })
        .finally(() => {
          if (requestSeq === requestSeqRef.current) setSearching(false)
        })
    }, CONTENT_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeout)
      if (searchStarted) void window.api.cancelContentSearch().catch(() => {})
    }
  }, [folderReadyPath, searchExcludes, trimmedQuery])

  const openResult = async (entry: ContentSearchEntry) => {
    try {
      const content = await window.api.readfile(entry.path)
      openFileSurface({ workspaceId, path: entry.path, name: entry.name, content })
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  if (checkingFolder) {
    // The folder is being verified on disk; mirror the resting search chrome
    // (input bar over an empty body) so the brief check reads as a quiet load
    // rather than a "Checking workspace…" message.
    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <span role="status" className="sr-only">
          Loading workspace…
        </span>
        <div aria-hidden="true" className="border-b border-[color:var(--border-default)] px-3 py-3">
          <Skeleton className="h-8 w-full rounded-md bg-[color:var(--skeleton-shimmer-high)]" />
        </div>
      </div>
    )
  }

  if (folderMissing || !folderReadyPath) {
    return <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-meta text-[color:var(--text-disabled)]">Open a folder to search file contents.</div>
  }

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      <div className="border-b border-[color:var(--border-default)] px-3 py-3">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file contents..."
          className="h-8 w-full rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-app)] px-3 text-meta text-[color:var(--text-strong)] placeholder-[color:var(--text-disabled)] outline-none transition-colors focus:border-[color:var(--color-5)]"
        />
        {statusText && (
          <div className={`mt-2 text-micro ${error ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-disabled)]'}`}>
            {statusText}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!trimmedQuery ? (
          <div className="px-4 py-3 text-meta text-[color:var(--text-disabled)]">Enter text to search this workspace.</div>
        ) : !searching && !error && results.length === 0 ? (
          <div className="px-4 py-3 text-meta text-[color:var(--text-disabled)]">No content matches.</div>
        ) : (
          <div className="divide-y divide-[color:var(--border-default)]">
            {results.map((entry, index) => {
              const fileLabel = relativePath(folderReadyPath, entry.path)
              const locator = `${entry.lineNumber}:${entry.column}`
              return (
                <InboxRow
                  key={`${entry.path}:${entry.lineNumber}:${entry.column}:${index}`}
                  tone="neutral"
                  title={
                    <span className="font-mono text-meta text-[color:var(--text-default)]">{fileLabel}</span>
                  }
                  supporting={
                    <span className="font-mono text-meta leading-5 text-[color:var(--text-muted)]">
                      {highlightLine(entry.lineText, entry.matchText)}
                    </span>
                  }
                  trailing={<span className="font-mono">{locator}</span>}
                  ariaLabel={`${fileLabel}:${locator}`}
                  onSelect={() => void openResult(entry)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
