import { useEffect, useMemo, useState } from 'react'
import { Tabs, Tooltip, type TabItem } from '../../ui'
import type { DesignerMockupFile } from './useDesignerSession'

type Props = {
  mockups: DesignerMockupFile[]
  watchDirectoryPath: string
}

type FrameState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'unavailable'; reason: string }

type BrowserOpenState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'failed'; reason: string }

export function htmlArtifactFrameSandbox(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts' : ''
}

// Reviewing a responsive mockup needs real device widths, not whatever width
// the pane happens to be. Fixed widths render the iframe on a centered,
// scrollable stage; Fit fills the pane. Zoom scales the rendered document
// while keeping its layout width truthful.
export type HtmlPreviewViewport = 'fit' | 1280 | 768 | 390

const PREVIEW_VIEWPORTS: ReadonlyArray<{ id: HtmlPreviewViewport; label: string }> = [
  { id: 'fit', label: 'Fit' },
  { id: 1280, label: '1280' },
  { id: 768, label: '768' },
  { id: 390, label: '390' },
]

const PREVIEW_ZOOMS = [1, 0.75, 0.5] as const
export type HtmlPreviewZoom = (typeof PREVIEW_ZOOMS)[number]

export function nextHtmlPreviewZoom(zoom: HtmlPreviewZoom): HtmlPreviewZoom {
  const index = PREVIEW_ZOOMS.indexOf(zoom)
  return PREVIEW_ZOOMS[(index + 1) % PREVIEW_ZOOMS.length]
}

export function browserOpenFailureMessage(
  relativePath: string,
  failure: 'missing' | 'handler',
  error?: unknown,
): string {
  if (failure === 'missing') {
    return `${relativePath} is missing on disk. Reload the preview or regenerate the mockup before opening it.`
  }
  const detail = error instanceof Error ? error.message.trim() : ''
  return detail
    ? `Could not open ${relativePath} in your browser: ${detail}`
    : `Could not open ${relativePath} in your browser. Check your default browser and try again.`
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.html?$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * Sandboxed HTML preview for a single real file on disk. Reads the file through
 * the existing IPC, re-reads on fs-watch changes and explicit reload, and runs
 * it in an iframe with scripts off by default behind an explicit allow-scripts
 * toggle. Shared by the mockup review tab and the Multicode Design preview pane
 * so the sandbox behavior is defined once. No `webview`; generated HTML never
 * receives same-origin privileges, and the interactive toggle only adds scripts.
 */
export function HtmlArtifactFrame({
  absolutePath,
  relativePath,
  watchDirectoryPath,
}: {
  absolutePath: string
  relativePath: string
  watchDirectoryPath: string
}) {
  const [allowScripts, setAllowScripts] = useState(false)
  const [frameState, setFrameState] = useState<FrameState>({ kind: 'loading' })
  const [browserOpenState, setBrowserOpenState] = useState<BrowserOpenState>({ kind: 'idle' })
  const [copiedPath, setCopiedPath] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  // Viewport and zoom deliberately persist across file changes — a review
  // pass at mobile width stays at mobile width while flipping screens.
  const [viewport, setViewport] = useState<HtmlPreviewViewport>('fit')
  const [zoom, setZoom] = useState<HtmlPreviewZoom>(1)
  // The iframe stays invisible until its document loads, so the empty white
  // canvas never flashes over the dark stage before a dark mockup paints.
  const [frameLoaded, setFrameLoaded] = useState(false)

  // Reset scripts to off whenever the previewed file changes — the safe default
  // must not carry over from a previously trusted file.
  useEffect(() => {
    setAllowScripts(false)
    setBrowserOpenState({ kind: 'idle' })
    setCopiedPath(false)
  }, [absolutePath])

  useEffect(() => {
    setFrameLoaded(false)
  }, [absolutePath, allowScripts, reloadNonce])

  useEffect(() => {
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(absolutePath)
        if (cancelled) return
        if (!exists) {
          setFrameState({ kind: 'unavailable', reason: `${relativePath} is missing on disk.` })
          return
        }
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        if (!content.trim()) {
          setFrameState({ kind: 'unavailable', reason: `${relativePath} is empty.` })
          return
        }
        setFrameState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setFrameState({
          kind: 'unavailable',
          reason:
            error instanceof Error
              ? `Could not read ${relativePath}: ${error.message}`
              : `Could not read ${relativePath}.`,
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
      .catch(() => {})

    return () => {
      cancelled = true
      if (stopWatch) void stopWatch()
    }
  }, [absolutePath, relativePath, watchDirectoryPath, reloadNonce])

  const onOpenInBrowser = async () => {
    setBrowserOpenState({ kind: 'opening' })
    try {
      const exists = await window.api.pathExists(absolutePath)
      if (!exists) {
        setBrowserOpenState({
          kind: 'failed',
          reason: browserOpenFailureMessage(relativePath, 'missing'),
        })
        return
      }
      await window.api.openHtmlFileInBrowser(absolutePath)
      setBrowserOpenState({ kind: 'idle' })
    } catch (error) {
      setBrowserOpenState({
        kind: 'failed',
        reason: browserOpenFailureMessage(relativePath, 'handler', error),
      })
    }
  }

  const onCopyPath = async () => {
    try {
      await window.api.clipboardWriteText(relativePath)
      setCopiedPath(true)
      window.setTimeout(() => setCopiedPath(false), 1400)
    } catch {
      // Clipboard failures are non-critical; leave the label unchanged.
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-[color:var(--text-muted)]">
          {relativePath}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span role="group" aria-label="Viewport width" className="flex items-center gap-0.5">
            {PREVIEW_VIEWPORTS.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setViewport(option.id)}
                aria-pressed={viewport === option.id}
                className={`
                  inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] tabular-nums
                  transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  ${viewport === option.id
                    ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'}
                `}
              >
                {option.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            onClick={() => setZoom((value) => nextHtmlPreviewZoom(value))}
            aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] tabular-nums text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            {Math.round(zoom * 100)}%
          </button>
          <Tooltip content="Reload">
            <button
              type="button"
              aria-label="Reload preview"
              onClick={() => setReloadNonce((nonce) => nonce + 1)}
              className="
                inline-flex h-6 w-6 items-center justify-center rounded-sm text-[color:var(--text-muted)]
                transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            >
              <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.5-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M13 1.8v3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip content={copiedPath ? 'Copied' : 'Copy path'}>
            <button
              type="button"
              aria-label="Copy path"
              onClick={() => void onCopyPath()}
              className="
                inline-flex h-6 w-6 items-center justify-center rounded-sm text-[color:var(--text-muted)]
                transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            >
              <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => setAllowScripts((value) => !value)}
            aria-pressed={allowScripts}
            className={`
              inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px]
              transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              ${allowScripts
                ? 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn)]'
                : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'}
            `}
          >
            {allowScripts ? (
              <>
                <span
                  aria-hidden="true"
                  className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none"
                >
                  !
                </span>
                Scripts on
              </>
            ) : (
              <>Allow interactive demo</>
            )}
          </button>
          <button
            type="button"
            onClick={() => void onOpenInBrowser()}
            disabled={browserOpenState.kind === 'opening'}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              disabled:cursor-wait disabled:opacity-60
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
            "
          >
            {browserOpenState.kind === 'opening' ? 'Opening…' : 'Open in browser'}
          </button>
        </span>
      </div>
      {browserOpenState.kind === 'failed' ? (
        <div
          role="alert"
          aria-live="polite"
          className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]"
        >
          {browserOpenState.reason}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-auto bg-[color:var(--bg-app)]">
        {frameState.kind === 'ready' ? (
          <div
            className={viewport === 'fit' ? 'h-full w-full' : 'flex min-h-full justify-center px-4 py-4'}
          >
            <div
              className={viewport === 'fit' ? 'h-full w-full overflow-hidden' : 'h-full shrink-0 overflow-hidden rounded-md border border-[color:var(--border-strong)]'}
              style={viewport === 'fit' ? undefined : { width: viewport * zoom }}
            >
              <iframe
                key={`${absolutePath}::${allowScripts ? 'scripts' : 'no-scripts'}::${reloadNonce}`}
                title={`Preview · ${relativePath}`}
                srcDoc={frameState.content}
                sandbox={htmlArtifactFrameSandbox(allowScripts)}
                onLoad={() => setFrameLoaded(true)}
                className={`border-0 bg-white transition-opacity duration-150 ${frameLoaded ? 'opacity-100' : 'opacity-0'}`}
                style={{
                  width: viewport === 'fit' ? `${100 / zoom}%` : viewport,
                  height: `${100 / zoom}%`,
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        ) : frameState.kind === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
            Loading preview…
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-[12px] font-semibold text-[color:var(--tone-warn)]">
              Preview unavailable
            </span>
            <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              {frameState.reason}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export function MockupPreviewPane({ mockups, watchDirectoryPath }: Props) {
  const [activeRelativePath, setActiveRelativePath] = useState<string | null>(null)

  const activeMockup = useMemo(
    () => mockups.find((m) => m.relativePath === activeRelativePath) ?? mockups[0] ?? null,
    [mockups, activeRelativePath],
  )

  useEffect(() => {
    if (!activeMockup && mockups[0]) {
      setActiveRelativePath(mockups[0].relativePath)
    }
  }, [activeMockup, mockups])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
          Your screens
        </span>
        <span className="truncate text-[12px] text-[color:var(--text-muted)]">
          {mockups.length} screen{mockups.length === 1 ? '' : 's'} ready
        </span>
      </header>

      {mockups.length > 0 ? (
        <Tabs<string>
          ariaLabel="Mockup screens"
          items={mockups.map((mockup, index): TabItem<string> => ({
            id: mockup.relativePath,
            label: `${String(index + 1).padStart(2, '0')} · ${titleFromFilename(mockup.name)}`,
          }))}
          value={activeMockup?.relativePath ?? mockups[0]?.relativePath ?? ''}
          onChange={(id) => setActiveRelativePath(id)}
        />
      ) : null}

      {activeMockup ? (
        <HtmlArtifactFrame
          absolutePath={activeMockup.absolutePath}
          relativePath={activeMockup.relativePath}
          watchDirectoryPath={watchDirectoryPath}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-6 text-center">
          <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">
            No mockups yet
          </span>
          <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            The designer will write screens into the workspace’s{' '}
            <span className="font-mono">mockups/</span> folder.
          </span>
        </div>
      )}
    </div>
  )
}
