import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { openFileSurface } from '../../utils/openFileSurface'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { EmptyState, InboxRow, InlineNotice, Input, PanelHeader, Skeleton } from '../ui'

// The panel names itself the same way in every state, including the one where
// the folder is still being verified and there is nothing to count yet.
const SEARCH_TITLE = 'Search in files'

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
    // The result count is the header's now — the canonical count next to the
    // panel's name — so this line carries only what the header cannot: how long
    // the search took.
    return `Searched in ${diagnostics.elapsedMs} ms`
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
      // The row already shows `line:column` and the panel has always known it —
      // it just never travelled, so every match opened its file at line 1.
      openFileSurface({
        workspaceId,
        path: entry.path,
        name: entry.name,
        content,
        lineNumber: entry.lineNumber,
        column: entry.column,
      })
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
        <PanelHeader title={SEARCH_TITLE} divider={false} />
        <div aria-hidden="true" className="border-b border-[color:var(--border-default)] px-3 py-2">
          <Skeleton className="h-control-sm w-full rounded-sm bg-[color:var(--skeleton-shimmer-high)]" />
        </div>
      </div>
    )
  }

  if (folderMissing || !folderReadyPath) {
    return (
      <div className="h-full bg-[color:var(--bg-app)]">
        <EmptyState title="Open a folder to search file contents." />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      {/* This panel had no identity row at all, and its search strip sat at
          `py-3` — 12px against the primitive's 8px — so it and the file tree
          beside it started at different heights (2112). The header names the
          panel and carries the result count; the strip below keeps the panel's
          one rule, which is why the header sets `divider={false}`. */}
      <PanelHeader
        title={SEARCH_TITLE}
        count={trimmedQuery && diagnostics ? `${diagnostics.resultCount}${diagnostics.truncated ? '+' : ''}` : undefined}
        divider={false}
      />
      <div className="border-b border-[color:var(--border-default)] px-3 py-2">
        {/* The kit field. This was an `h-8` box (28px, off the 26/30/34 ramp)
            edged with `--bg-selected` — a SELECTION fill used as a border —
            rather than the border ramp (MC-2114). */}
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file contents..."
          aria-label="Search file contents"
        />
        {/* A failed search is the error card, never red ink alone; a status
            line is readable muted ink (2026-09-02 audit). */}
        {statusText && error ? (
          <InlineNotice tone="error" className="mt-2">
            {statusText}
          </InlineNotice>
        ) : statusText ? (
          <div role="status" className="mt-2 text-micro text-[color:var(--text-muted)]">
            {statusText}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!trimmedQuery ? (
          <EmptyState density="list" title="Enter text to search this workspace." />
        ) : !searching && !error && results.length === 0 ? (
          <EmptyState density="list" title="No content matches." />
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
