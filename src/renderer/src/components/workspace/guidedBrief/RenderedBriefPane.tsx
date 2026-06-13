import { useEffect, useState } from 'react'
import { renderMarkdown } from '../../../utils/markdown'

type Props = {
  briefPath: string
  watchDirectoryPath: string
  title?: string
  unavailableTitle?: string
  missingReason?: string
  emptyReason?: string
  copyPathLabel?: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'unavailable'; reason: string }

function relativeFromWorkspace(briefPath: string, workspaceDir: string): string {
  if (!briefPath.startsWith(workspaceDir)) return briefPath
  const remainder = briefPath.slice(workspaceDir.length).replace(/^[\\/]+/, '')
  return remainder.replace(/\\/g, '/')
}

export function RenderedBriefPane({
  briefPath,
  watchDirectoryPath,
  title = 'Your brief',
  unavailableTitle = 'Brief not available',
  missingReason = 'product/requirements.md has not been written yet.',
  emptyReason = 'product/requirements.md is empty.',
  copyPathLabel,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(briefPath)
        if (cancelled) return
        if (!exists) {
          setState({
            kind: 'unavailable',
            reason: missingReason,
          })
          return
        }
        const content = await window.api.readfile(briefPath)
        if (cancelled) return
        if (!content.trim()) {
          setState({
            kind: 'unavailable',
            reason: emptyReason,
          })
          return
        }
        setState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'unavailable',
          reason:
            error instanceof Error
              ? `Could not read the brief: ${error.message}`
              : 'Could not read the brief.',
        })
      }
    }

    void load()
    void window.api
      .watchPath(watchDirectoryPath, () => {
        void load()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {
        // Watch may fail; the initial read is still valid.
      })

    return () => {
      cancelled = true
      if (stopWatch) void stopWatch()
    }
  }, [briefPath, watchDirectoryPath, missingReason, emptyReason])

  const relativePath = relativeFromWorkspace(briefPath, watchDirectoryPath.replace(/[\\/]+product$/, ''))
  const pathToCopy = copyPathLabel ?? relativePath

  const copyPath = async () => {
    try {
      await window.api.clipboardWriteText(pathToCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard failures are non-critical; leave the label unchanged.
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
            {title}
          </span>
          <span className="inline-flex items-center gap-1.5 truncate text-[12px] text-[color:var(--text-muted)]">
            {state.kind === 'ready' ? (
              <span className="font-mono">{relativePath}</span>
            ) : state.kind === 'loading' ? (
              'Loading the brief…'
            ) : (
              state.reason
            )}
          </span>
        </div>
        {state.kind === 'ready' ? (
          <button
            type="button"
            onClick={() => void copyPath()}
            className="
              inline-flex h-6 shrink-0 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-5 py-5">
        {state.kind === 'ready' ? (
          <div className="text-[14px] leading-7 text-[color:var(--text-strong)]">
            {renderMarkdown(state.content)}
          </div>
        ) : state.kind === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
            Reading the brief…
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-[12px] font-semibold text-[color:var(--tone-warn)]">
              {unavailableTitle}
            </span>
            <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              {state.reason}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
