import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { htmlArtifactFrameSandbox, Skeleton, Tabs, Tooltip, TruncatedText, type TabItem } from '../../ui'
import {
  anchorFromSelect,
  addAnnotation,
  annotateAvailability,
  annotateFrameSandbox,
  removeAnnotation,
  submitFailureMessage,
  updateAnnotationMessage,
  type AnnotateComposerState,
  type AnnotateSubmitState,
} from './annotate/annotateModel'
import { AnnotateOverlay } from './annotate/AnnotateOverlay'
import { AnnotateTray } from './annotate/AnnotateTray'
import { composeAnnotateSrcDoc } from './annotate/annotateSrcDoc'
import {
  buildAnnotateLocateRequest,
  readTrustedAnnotateMessage,
  type ScrollOffset,
} from './annotate/bridge'
import type { AnnotationRect, MockupAnnotation } from './annotate/types'
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
  // Opt-in annotate mode, forwarded to the frame (see HtmlArtifactFrame).
  onSubmitAnnotations?: (annotations: MockupAnnotation[]) => Promise<void>
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

// Stable empty batch so files without notes never churn effect dependencies.
const EMPTY_ANNOTATION_BATCH: MockupAnnotation[] = []

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
  onSubmitAnnotations,
}: {
  absolutePath: string
  relativePath: string
  watchDirectoryPath: string
  enableSourceView?: boolean
  /**
   * Opt-in annotate mode (MC-1468), the same opt-in-prop pattern as
   * `enableSourceView`: passing the callback is the opt-in, so the mode can
   * never be enabled without a real batch destination. The frame collects
   * element-anchored notes and submits them as ONE batch through this seam; it
   * contains no feedback-routing logic — where a batch goes is entirely the
   * host's decision (sprint request-changes, wizard chat, …).
   */
  onSubmitAnnotations?: (annotations: MockupAnnotation[]) => Promise<void>
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

  // --- Annotate mode (MC-1468 part 2) ---------------------------------------
  // Pending batches are keyed per file and live HERE, in the parent of the
  // iframe — so a batch survives entering Source view, a file reload, and the
  // annotate iframe remount itself. The capture mode stays on across screen
  // switches (a review sweep spans screens); each screen keeps its own batch.
  const annotateEnabled = typeof onSubmitAnnotations === 'function'
  const [annotateOn, setAnnotateOn] = useState(false)
  const [annotationBatches, setAnnotationBatches] = useState<Record<string, MockupAnnotation[]>>({})
  const [composer, setComposer] = useState<AnnotateComposerState>({ kind: 'closed' })
  const [submitState, setSubmitState] = useState<AnnotateSubmitState>({ kind: 'idle' })
  const [trayListOpen, setTrayListOpen] = useState(false)
  // Live frame geometry from the validated bridge: current scroll offset and
  // the freshest located rect per selector (null = unanchored).
  const [frameScroll, setFrameScroll] = useState<ScrollOffset>({ x: 0, y: 0 })
  const [anchorRects, setAnchorRects] = useState<Record<string, AnnotationRect | null>>({})
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const commentToggleRef = useRef<HTMLButtonElement>(null)

  // Reset scripts to off whenever the previewed file changes — the safe default
  // must not carry over from a previously trusted file. Per-frame annotate
  // geometry and the composer reset with it; the pending batches do not.
  useEffect(() => {
    setAllowScripts(false)
    setBrowserOpenState({ kind: 'idle' })
    setCopiedPath(false)
    setComposer({ kind: 'closed' })
    setSubmitState({ kind: 'idle' })
    setTrayListOpen(false)
    setFrameScroll({ x: 0, y: 0 })
    setAnchorRects({})
  }, [absolutePath])

  useEffect(() => {
    setFrameLoaded(false)
  }, [absolutePath, allowScripts, reloadNonce, annotateOn])

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

  const availability = annotateAvailability(frameState.kind)
  // Capture is live only while a document is rendered; the toggle state itself
  // survives an unavailable interlude (e.g. the file is being rewritten).
  const annotateActive = annotateEnabled && annotateOn && availability.available && view.showsRenderedFrame
  const batch = annotationBatches[absolutePath] ?? EMPTY_ANNOTATION_BATCH
  const submitting = submitState.kind === 'submitting'

  const setBatch = (next: MockupAnnotation[]) => {
    setAnnotationBatches((batches) => {
      if (next.length === 0) {
        const { [absolutePath]: _removed, ...rest } = batches
        return rest
      }
      return { ...batches, [absolutePath]: next }
    })
  }

  const postLocate = (selectors: readonly string[]) => {
    iframeRef.current?.contentWindow?.postMessage(buildAnnotateLocateRequest(selectors), '*')
  }

  // Bridge listener: only messages from our own iframe's contentWindow are
  // trusted (source identity — the sandboxed frame is an opaque origin).
  useEffect(() => {
    if (!annotateActive) return
    const onMessage = (event: MessageEvent) => {
      const message = readTrustedAnnotateMessage(event, iframeRef.current?.contentWindow ?? null)
      if (!message) return
      switch (message.type) {
        case 'ready':
          // A (re)loaded document starts unscrolled; re-anchor the batch in it.
          setFrameScroll({ x: 0, y: 0 })
          postLocate(batch.map((annotation) => annotation.selector))
          break
        case 'scroll':
          setFrameScroll(message.scrollOffset)
          break
        case 'anchors': {
          const next: Record<string, AnnotationRect | null> = {}
          for (const anchor of message.anchors) next[anchor.selector] = anchor.rect
          setAnchorRects(next)
          setFrameScroll(message.scrollOffset)
          break
        }
        case 'select':
          if (submitting) break
          setComposer((prev) => {
            // An explicit edit session is never discarded by a stray click; a
            // new draft re-anchors to the latest selection, keeping its text.
            if (prev.kind === 'edit') return prev
            return {
              kind: 'new',
              anchor: anchorFromSelect(message),
              message: prev.kind === 'new' ? prev.message : '',
            }
          })
          break
        case 'hover':
        case 'hover-end':
          // The identity chip renders inside the frame (picker runtime).
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [annotateActive, batch, submitting])

  // Re-anchor whenever the batch or the projection inputs change; the picker
  // itself re-reports after in-frame reflows (zoom/viewport resize).
  useEffect(() => {
    if (!annotateActive) return
    postLocate(batch.map((annotation) => annotation.selector))
  }, [annotateActive, batch, zoom, viewport])

  const onToggleAnnotate = () => {
    setComposer({ kind: 'closed' })
    setTrayListOpen(false)
    setAnnotateOn((value) => !value)
  }

  // Escape exits Comment mode and returns focus to its toggle. The composer
  // and the tray list handle their own Escape first (and stop propagation).
  const onFrameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !annotateActive) return
    setAnnotateOn(false)
    commentToggleRef.current?.focus()
  }

  const onComposerCommit = () => {
    if (composer.kind === 'closed') return
    const message = composer.message.trim()
    if (!message) return
    if (composer.kind === 'new') {
      setBatch(addAnnotation(batch, { ...composer.anchor, message }))
    } else {
      setBatch(updateAnnotationMessage(batch, composer.index, message))
    }
    setComposer({ kind: 'closed' })
  }

  const onComposerRemove = () => {
    if (composer.kind !== 'edit') return
    setBatch(removeAnnotation(batch, composer.index))
    setComposer({ kind: 'closed' })
  }

  const onEditAnnotation = (index: number) => {
    if (submitting || !availability.available) return
    const annotation = batch[index]
    if (!annotation) return
    // Editing from the tray while capture is off re-enters Comment mode so the
    // composer has a surface to anchor to.
    setAnnotateOn(true)
    setComposer({ kind: 'edit', index, message: annotation.message })
  }

  const onSendBatch = async () => {
    if (!onSubmitAnnotations || batch.length === 0 || submitting) return
    const pathAtSubmit = absolutePath
    setComposer({ kind: 'closed' })
    setSubmitState({ kind: 'submitting' })
    try {
      await onSubmitAnnotations(batch)
      setAnnotationBatches((batches) => {
        const { [pathAtSubmit]: _sent, ...rest } = batches
        return rest
      })
      setTrayListOpen(false)
      setSubmitState({ kind: 'idle' })
    } catch (error) {
      // The batch is deliberately untouched — a failed send keeps every note.
      setSubmitState({ kind: 'failed', reason: submitFailureMessage(error) })
    }
  }

  // Annotate mode swaps the srcDoc for the composed one (author scripts
  // neutralized, picker injected); the normal preview path is untouched.
  const annotateSrcDoc = useMemo(
    () => (annotateActive && frameState.kind === 'ready' ? composeAnnotateSrcDoc(frameState.content) : null),
    [annotateActive, frameState],
  )

  return (
    <div
      onKeyDown={onFrameKeyDown}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
    >
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
          {annotateEnabled && view.showsPreviewControls ? (
            // aria-disabled (not disabled) keeps the unavailable toggle
            // hoverable and focusable, so the reason tooltip actually reaches
            // the user instead of a dead control.
            <CommentToggle
              buttonRef={commentToggleRef}
              active={annotateActive}
              unavailableReason={availability.available ? null : availability.reason}
              onToggle={onToggleAnnotate}
            />
          ) : null}
          {view.showsPreviewControls && !annotateActive ? (
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
              className={viewport === 'fit' ? 'relative h-full w-full overflow-hidden' : 'relative h-full shrink-0 overflow-hidden rounded-md border border-[color:var(--border-strong)]'}
              style={viewport === 'fit' ? undefined : { width: viewport * zoom }}
            >
              <iframe
                ref={iframeRef}
                key={`${absolutePath}::${annotateActive ? 'annotate' : allowScripts ? 'scripts' : 'no-scripts'}::${reloadNonce}`}
                title={`Preview · ${pageTitle}`}
                srcDoc={annotateSrcDoc ?? frameState.content}
                sandbox={annotateFrameSandbox(annotateActive, allowScripts)}
                onLoad={() => setFrameLoaded(true)}
                className={`border-0 bg-white transition-opacity duration-150 ${frameLoaded ? 'opacity-100' : 'opacity-0'}`}
                style={{
                  width: viewport === 'fit' ? `${100 / zoom}%` : viewport,
                  height: `${100 / zoom}%`,
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              />
              {annotateActive ? (
                <AnnotateOverlay
                  annotations={batch}
                  anchors={anchorRects}
                  transform={{ zoom, scroll: frameScroll, offsetX: 0, offsetY: 0 }}
                  composer={composer}
                  busy={submitting}
                  onOpenEdit={onEditAnnotation}
                  onComposerMessageChange={(message) =>
                    setComposer((prev) => (prev.kind === 'closed' ? prev : { ...prev, message }))
                  }
                  onComposerCancel={() => setComposer({ kind: 'closed' })}
                  onComposerCommit={onComposerCommit}
                  onComposerRemove={onComposerRemove}
                />
              ) : null}
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
      {/* The batch tray floats over the stage (a sibling of the scroll container,
          so it never scrolls away) whenever this file has pending notes — even
          with capture toggled off, pending feedback is never invisible. */}
      {annotateEnabled && view.showsRenderedFrame && batch.length > 0 ? (
        <AnnotateTray
          annotations={batch}
          anchors={anchorRects}
          submitState={submitState}
          listOpen={trayListOpen}
          onToggleList={() => setTrayListOpen((value) => !value)}
          onEdit={onEditAnnotation}
          onRemove={(index) => setBatch(removeAnnotation(batch, index))}
          onClear={() => {
            setBatch([])
            setTrayListOpen(false)
            setComposer({ kind: 'closed' })
          }}
          onSend={() => void onSendBatch()}
        />
      ) : annotateActive && composer.kind === 'closed' ? (
        <span
          role="status"
          className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-1 text-[11px] text-[color:var(--text-muted)] shadow-[var(--shadow-drawer)]"
        >
          Click any element in the preview to pin a note
        </span>
      ) : null}
    </div>
  )
}

/**
 * The annotate/Comment mode toggle in the frame header. Unavailable states
 * (file missing, still generating, unreadable, loading) keep the control
 * focusable via aria-disabled so the Tooltip can explain why; activation is
 * simply a no-op until the file renders again.
 */
function CommentToggle({
  buttonRef,
  active,
  unavailableReason,
  onToggle,
}: {
  buttonRef: RefObject<HTMLButtonElement>
  active: boolean
  unavailableReason: string | null
  onToggle: () => void
}) {
  const unavailable = unavailableReason !== null
  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={unavailable ? undefined : onToggle}
      aria-pressed={active}
      aria-disabled={unavailable || undefined}
      className={`
        inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px]
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        ${unavailable ? 'cursor-not-allowed text-[color:var(--text-muted)] opacity-50' : ''}
        ${!unavailable && active ? 'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]' : ''}
        ${!unavailable && !active ? 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]' : ''}
      `}
    >
      <svg viewBox="0 0 14 14" className="icon-xs" aria-hidden="true">
        <path
          d="M9.5 2.5 11.5 4.5 5 11l-2.5.5L3 9z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      {active ? 'Commenting' : 'Comment'}
    </button>
  )
  return unavailable ? <Tooltip content={unavailableReason}>{button}</Tooltip> : button
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

export function MockupPreviewPane({
  mockups,
  watchDirectoryPath,
  enableSourceView = false,
  onSubmitAnnotations,
}: Props) {
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
          onSubmitAnnotations={onSubmitAnnotations}
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
