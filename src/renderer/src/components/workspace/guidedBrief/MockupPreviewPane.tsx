import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { htmlArtifactFrameSandbox, Skeleton, Tabs, Tooltip, TruncatedText, type TabItem } from '../../ui'
import { basename } from './paths'
import type { DesignerMockupFile } from './useDesignerSession'

// The scripts-off sandbox policy is defined once in the shared HtmlPreviewCard
// home (ui/) and reused here — re-exported so existing importers of the helper
// (and the sandbox unit tests) keep resolving it from this module.
export { htmlArtifactFrameSandbox }

type Props = {
  mockups: DesignerMockupFile[]
  watchDirectoryPath: string
  // Opt-in Preview/Source toggle for the "Started from" seed preview. Default
  // off keeps the Design Wizard usage unchanged.
  enableSourceView?: boolean
}

// The preview never shows an undesigned void: every non-rendered situation maps
// to one of four designed states derived from a real file signal (MC-1505).
// `generating` = the file exists but is still empty (the agent is mid-write);
// `deleted` = the selected file is gone from disk; `error` = it could not be
// read. `loading` is the brief first read before any of these resolve.
type FrameState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'generating' }
  | { kind: 'deleted' }
  | { kind: 'error'; reason: string }

type BrowserOpenState =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'failed'; reason: string }

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

// The Source view is an opt-in mode (default off) so the Design Wizard preview
// is unchanged. When it is off the frame behaves exactly as before: no toggle,
// always the rendered iframe, all preview controls. Source only exists to read
// the raw HTML text, so it hides the preview-only controls (viewport, zoom,
// allow-scripts) that shape the rendered iframe and never itself run scripts.
export type HtmlArtifactViewMode = 'preview' | 'source'

export type HtmlArtifactView = {
  showToggle: boolean
  mode: HtmlArtifactViewMode
  showsRenderedFrame: boolean
  showsSource: boolean
  showsPreviewControls: boolean
}

export function resolveHtmlArtifactView(
  enableSourceView: boolean,
  viewMode: HtmlArtifactViewMode,
): HtmlArtifactView {
  const mode: HtmlArtifactViewMode = enableSourceView ? viewMode : 'preview'
  const isSource = mode === 'source'
  return {
    showToggle: enableSourceView,
    mode,
    showsRenderedFrame: !isSource,
    showsSource: isSource,
    showsPreviewControls: !isSource,
  }
}

const HTML_ARTIFACT_VIEW_MODES: ReadonlyArray<{ id: HtmlArtifactViewMode; label: string }> = [
  { id: 'preview', label: 'Preview' },
  { id: 'source', label: 'Source' },
]

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

/**
 * A human display title for a file, used as the fallback when no HTML `<title>`
 * is present: drop the extension, strip a leading ISO date prefix
 * (`2026-07-06-panel-header.html` → `Panel header`) so a raw date-prefixed
 * filename never reads as a primary label (MC-1505), then sentence-case.
 */
export function humanizeFileTitle(name: string): string {
  const base = basename(name)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return basename(name)
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/** The `<title>` text of an HTML document, whitespace-collapsed; null when absent or empty. */
export function pageTitleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  const text = match[1].replace(/\s+/g, ' ').trim()
  return text || null
}

/**
 * The preview title bar's primary label for an HTML file: its `<title>` when the
 * content is loaded and has one, otherwise the humanized filename. The path is
 * shown demoted beneath it, never as the primary label.
 */
export function htmlPreviewTitle(relativePath: string, content: string | null): string {
  const fromDocument = content ? pageTitleFromHtml(content) : null
  return fromDocument ?? humanizeFileTitle(relativePath)
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
  enableSourceView = false,
}: {
  absolutePath: string
  relativePath: string
  watchDirectoryPath: string
  enableSourceView?: boolean
}) {
  const [allowScripts, setAllowScripts] = useState(false)
  const [viewMode, setViewMode] = useState<HtmlArtifactViewMode>('preview')
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
          setFrameState({ kind: 'deleted' })
          return
        }
        const content = await window.api.readfile(absolutePath)
        if (cancelled) return
        if (!content.trim()) {
          // Exists but empty — the agent is still writing it. A designed
          // generating state, never a black void.
          setFrameState({ kind: 'generating' })
          return
        }
        setFrameState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setFrameState({
          kind: 'error',
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

  const view = resolveHtmlArtifactView(enableSourceView, viewMode)
  // The page title (from the document's own <title>) leads; the path is demoted
  // beneath it. Falls back to the humanized filename before the content loads.
  const pageTitle = htmlPreviewTitle(relativePath, frameState.kind === 'ready' ? frameState.content : null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <span className="flex min-w-0 flex-col leading-tight">
          <TruncatedText
            as="span"
            text={pageTitle}
            className="min-w-0 text-[12px] font-semibold text-[color:var(--text-strong)]"
          />
          <TruncatedText
            as="span"
            text={relativePath}
            className="min-w-0 font-mono text-[10px] text-[color:var(--text-subtle)]"
          />
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {view.showToggle ? (
            <span role="group" aria-label="View mode" className="flex items-center gap-0.5">
              {HTML_ARTIFACT_VIEW_MODES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setViewMode(option.id)}
                  aria-pressed={view.mode === option.id}
                  className={`
                    inline-flex h-6 items-center rounded-sm px-1.5 text-[11px]
                    transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                    ${view.mode === option.id
                      ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]'}
                  `}
                >
                  {option.label}
                </button>
              ))}
            </span>
          ) : null}
          {view.showsPreviewControls ? (
            <>
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
              {/* Hairline between the viewport+zoom cluster and the actions cluster. */}
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[color:var(--border-subtle)]" />
            </>
          ) : null}
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
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
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
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </Tooltip>
          {view.showsPreviewControls ? (
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
          ) : null}
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
        {frameState.kind === 'ready' && view.showsSource ? (
          <pre className="m-0 min-h-full whitespace-pre px-4 py-3 font-mono text-[11px] leading-5 text-[color:var(--text-default)]">
            {frameState.content}
          </pre>
        ) : frameState.kind === 'ready' ? (
          <div
            className={viewport === 'fit' ? 'h-full w-full' : 'flex min-h-full justify-center px-4 py-4'}
          >
            <div
              className={viewport === 'fit' ? 'h-full w-full overflow-hidden' : 'h-full shrink-0 overflow-hidden rounded-md border border-[color:var(--border-strong)]'}
              style={viewport === 'fit' ? undefined : { width: viewport * zoom }}
            >
              <iframe
                key={`${absolutePath}::${allowScripts ? 'scripts' : 'no-scripts'}::${reloadNonce}`}
                title={`Preview · ${pageTitle}`}
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
        ) : frameState.kind === 'generating' ? (
          <PreviewState
            title="Building this page…"
            body="The preview refreshes automatically as the file is written."
            skeleton
          />
        ) : frameState.kind === 'deleted' ? (
          <PreviewState
            glyph="deleted"
            title="This file isn’t on disk"
            path={relativePath}
            body="It may have been removed since you selected it, or not written yet. Pick another file, or reload."
          />
        ) : frameState.kind === 'error' ? (
          <PreviewState glyph="error" tone="warn" title="This file can’t be previewed" body={frameState.reason} />
        ) : (
          <PreviewState title="Loading preview…" skeleton />
        )}
        {/* Paint gap: hold a shimmer over the dark stage until the iframe's own
            document paints, so a dark mockup never flashes an undesigned void. */}
        {frameState.kind === 'ready' && !view.showsSource && !frameLoaded ? (
          <div className="pointer-events-none absolute inset-0 bg-[color:var(--bg-surface)]">
            <PreviewSkeletonLines />
          </div>
        ) : null}
      </div>
    </div>
  )
}

type PreviewStateGlyph = 'deleted' | 'error'

/**
 * A designed non-render state shared by the HTML preview frame and the artifact
 * preview pane (MC-1505): a shape glyph, a title, an optional demoted path, and
 * body copy — neutral by default, warn-toned for a genuine failure. The glyph
 * shape (not color) carries the meaning, so it survives grayscale. `skeleton`
 * swaps the glyph for a shimmer stack for the generating/loading states.
 */
export function PreviewState({
  glyph,
  tone = 'neutral',
  title,
  path,
  body,
  skeleton = false,
}: {
  glyph?: PreviewStateGlyph
  tone?: 'neutral' | 'warn'
  title: string
  path?: string
  body?: ReactNode
  skeleton?: boolean
}) {
  if (skeleton) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex flex-col items-center gap-1">
          <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">{title}</span>
          {body ? (
            <span className="max-w-[360px] text-[12px] leading-5 text-[color:var(--text-muted)]">{body}</span>
          ) : null}
        </span>
        <span className="flex w-full max-w-[280px] flex-col gap-2.5">
          <Skeleton className="h-3 w-3/5 rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-3 w-4/5 rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-24 w-full rounded bg-[color:var(--bg-surface-raised)]" />
          <Skeleton className="h-3 w-2/5 rounded bg-[color:var(--bg-surface-raised)]" />
        </span>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {glyph ? <PreviewGlyph glyph={glyph} tone={tone} /> : null}
      <span
        className={`text-[12px] font-semibold ${
          tone === 'warn' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {title}
      </span>
      {path ? (
        <span className="max-w-full truncate font-mono text-[11px] text-[color:var(--text-subtle)]">{path}</span>
      ) : null}
      {body ? (
        <span className="max-w-[360px] text-[12px] leading-5 text-[color:var(--text-muted)]">{body}</span>
      ) : null}
    </div>
  )
}

function PreviewGlyph({ glyph, tone }: { glyph: PreviewStateGlyph; tone: 'neutral' | 'warn' }) {
  const color = tone === 'warn' ? 'var(--tone-warn)' : 'var(--text-subtle)'
  if (glyph === 'error') {
    return (
      <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true" style={{ color }}>
        <path d="M8 2 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 6.5v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  // deleted — a hollow circle with a diagonal slash (removed from the set).
  return (
    <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true" style={{ color }}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.2 11.8 11.8 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Centered shimmer stack, filling its container — the paint-gap overlay behind
// a not-yet-painted iframe. The shared Skeleton honors prefers-reduced-motion.
function PreviewSkeletonLines() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6">
      <span className="flex w-full max-w-[280px] flex-col gap-2.5">
        <Skeleton className="h-3 w-3/5 rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-3 w-4/5 rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-24 w-full rounded bg-[color:var(--bg-surface-raised)]" />
        <Skeleton className="h-3 w-2/5 rounded bg-[color:var(--bg-surface-raised)]" />
      </span>
    </div>
  )
}

export function MockupPreviewPane({ mockups, watchDirectoryPath, enableSourceView = false }: Props) {
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
            label: `${String(index + 1).padStart(2, '0')} · ${humanizeFileTitle(mockup.name)}`,
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
          enableSourceView={enableSourceView}
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
