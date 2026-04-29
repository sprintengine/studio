import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab } from '../../utils/modelRegistry'

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
      <mark className="rounded-sm bg-[#f2c45f]/24 px-0.5 text-[#ffe4a3]">{lineText.slice(index, index + matchText.length)}</mark>
      {lineText.slice(index + matchText.length)}
    </>
  )
}

export default function ContentSearchPanel({ workspaceId }: Props) {
  const { folderReadyPath, folderMissing, checkingFolder } = useWorkspaceFolderStatus(workspaceId)
  const openFile = useWorkspaceStore((s) => s.openFile)
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
      openFile(workspaceId, entry.path, entry.name, content)
      focusOrAddFileTab(workspaceId, entry.path, entry.name)
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  if (checkingFolder) {
    return <div className="flex h-full items-center justify-center bg-[#08090b] text-[12px] text-[#5a5a63]">Checking workspace...</div>
  }

  if (folderMissing || !folderReadyPath) {
    return <div className="flex h-full items-center justify-center bg-[#08090b] px-6 text-center text-[12px] text-[#5a5a63]">Open a folder to search file contents.</div>
  }

  return (
    <div className="flex h-full flex-col bg-[#08090b]">
      <div className="border-b border-[#1f2025] px-3 py-3">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file contents..."
          className="h-8 w-full rounded-md border border-[#24252b] bg-[#090a0c] px-3 text-[12px] text-[#ececee] placeholder-[#5a5a63] outline-none transition-colors focus:border-[#303139]"
        />
        {statusText && (
          <div className={`mt-2 text-[11px] ${error ? 'text-[#ff9b9f]' : 'text-[#5a5a63]'}`}>
            {statusText}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!trimmedQuery ? (
          <div className="px-4 py-3 text-[12px] text-[#5a5a63]">Enter text to search this workspace.</div>
        ) : !searching && !error && results.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-[#5a5a63]">No content matches.</div>
        ) : (
          <div className="divide-y divide-[#16171c]">
            {results.map((entry, index) => {
              const fileLabel = relativePath(folderReadyPath, entry.path)
              return (
                <button
                  key={`${entry.path}:${entry.lineNumber}:${entry.column}:${index}`}
                  type="button"
                  onClick={() => void openResult(entry)}
                  className="block w-full px-4 py-2.5 text-left transition-colors hover:bg-[#111216] focus:bg-[#111216] focus:outline-none"
                  title={`${fileLabel}:${entry.lineNumber}:${entry.column}`}
                >
                  <div className="flex min-w-0 items-center gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-mono text-[#d7d7dc]">{fileLabel}</span>
                    <span className="shrink-0 font-mono text-[#5a5a63]">{entry.lineNumber}:{entry.column}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[12px] leading-5 text-[#9a9aa2]">
                    {highlightLine(entry.lineText, entry.matchText)}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
