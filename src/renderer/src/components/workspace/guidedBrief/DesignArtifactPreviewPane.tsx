import { useEffect, useState } from 'react'
import { TruncatedText } from '../../ui'
import { parentPath } from '../../../utils/paths'
import { HtmlArtifactFrame, PreviewState, humanizeFileTitle } from './MockupPreviewPane'
import { RenderedBriefPane } from './RenderedBriefPane'
import { previewKindForArtifact, type DesignArtifactEntry } from './designArtifacts'
import type { MockupAnnotation } from './annotate/types'

type Props = {
  /** The artifact selected via the canvas screen switcher, or null when nothing is selected. */
  entry: DesignArtifactEntry | null
  /**
   * Opt-in annotate mode (MC-1468), forwarded to the HTML frame: element-pinned
   * notes collected on a rendered page leave as one batch through this
   * callback. Only HTML artifacts have an annotate surface; the host decides
   * where a batch goes (here: the designer session's chat).
   */
  onSubmitAnnotations?: (annotations: MockupAnnotation[]) => Promise<void>
  /** Host-named tray send action, forwarded with the sink ("Send to designer"). */
  annotateSubmitLabel?: string
}

// The preview title bar: the file's human title leads, the path is demoted
// beneath it (never the primary label, per MC-1505). The type label and the
// reload / copy-path actions sit in the trailing actions cluster.
function PreviewHeader({
  title,
  relativePath,
  typeLabel,
  onReload,
  onCopyPath,
}: {
  title: string
  relativePath: string
  typeLabel: string
  onReload?: () => void
  onCopyPath?: () => Promise<void>
}) {
  const [copied, setCopied] = useState(false)

  const copyPath = async () => {
    if (!onCopyPath) return
    try {
      await onCopyPath()
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard failures are non-critical; leave the label unchanged.
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2">
      <span className="flex min-w-0 flex-col leading-tight">
        <TruncatedText
          as="span"
          text={title}
          className="min-w-0 text-[12px] font-semibold text-[color:var(--text-strong)]"
        />
        <TruncatedText
          as="span"
          text={relativePath}
          className="min-w-0 font-mono text-[10px] text-[color:var(--text-subtle)]"
        />
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-[color:var(--text-muted)]">{typeLabel}</span>
        {onReload ? (
          <button
            type="button"
            onClick={onReload}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
          >
            Reload
          </button>
        ) : null}
        {onCopyPath ? (
          <button
            type="button"
            onClick={() => void copyPath()}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
            "
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        ) : null}
      </span>
    </div>
  )
}

async function copyRelativePath(relativePath: string): Promise<void> {
  await window.api.clipboardWriteText(relativePath)
}

// Missing on disk → the selected file was deleted since it was picked; a read
// failure → a genuine error. Both are designed states, never a bare void.
type ImageState =
  | { kind: 'loading' }
  | { kind: 'ready'; dataUrl: string }
  | { kind: 'deleted' }
  | { kind: 'error'; reason: string }

function ImageArtifactView({ entry }: { entry: DesignArtifactEntry }) {
  const [state, setState] = useState<ImageState>({ kind: 'loading' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const watchDirectoryPath = parentPath(entry.absolutePath)

  useEffect(() => {
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(entry.absolutePath)
        if (cancelled) return
        if (!exists) {
          setState({ kind: 'deleted' })
          return
        }
        const dataUrl = await window.api.readImageDataUrl(entry.absolutePath)
        if (cancelled) return
        if (!dataUrl) {
          setState({ kind: 'error', reason: `${entry.relativePath} could not be read as an image.` })
          return
        }
        setState({ kind: 'ready', dataUrl })
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'error',
          reason:
            error instanceof Error
              ? `Could not read ${entry.relativePath}: ${error.message}`
              : `Could not read ${entry.relativePath}.`,
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
  }, [entry.absolutePath, entry.relativePath, watchDirectoryPath, reloadNonce])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <PreviewHeader
        title={humanizeFileTitle(entry.name)}
        relativePath={entry.relativePath}
        typeLabel={entry.typeLabel}
        onReload={() => setReloadNonce((nonce) => nonce + 1)}
        onCopyPath={() => copyRelativePath(entry.relativePath)}
      />
      <div className="relative min-h-0 flex-1 overflow-auto bg-[color:var(--bg-app)] p-4">
        {state.kind === 'ready' ? (
          <img
            src={state.dataUrl}
            alt={entry.relativePath}
            className="mx-auto h-auto max-h-full w-auto max-w-full object-contain"
          />
        ) : state.kind === 'loading' ? (
          <PreviewState title="Loading image…" skeleton />
        ) : state.kind === 'deleted' ? (
          <PreviewState
            glyph="deleted"
            title="This file isn’t on disk"
            path={entry.relativePath}
            body="It may have been removed since you selected it, or not written yet. Pick another file, or reload."
          />
        ) : (
          <PreviewState glyph="error" tone="warn" title="Image unavailable" body={state.reason} />
        )}
      </div>
    </div>
  )
}

type SourceState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'empty' }
  | { kind: 'deleted' }
  | { kind: 'error'; reason: string }

function SourceArtifactView({ entry }: { entry: DesignArtifactEntry }) {
  const [state, setState] = useState<SourceState>({ kind: 'loading' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const watchDirectoryPath = parentPath(entry.absolutePath)

  useEffect(() => {
    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(entry.absolutePath)
        if (cancelled) return
        if (!exists) {
          setState({ kind: 'deleted' })
          return
        }
        const content = await window.api.readfile(entry.absolutePath)
        if (cancelled) return
        if (!content.trim()) {
          setState({ kind: 'empty' })
          return
        }
        setState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'error',
          reason:
            error instanceof Error
              ? `Could not read ${entry.relativePath}: ${error.message}`
              : `Could not read ${entry.relativePath}.`,
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
  }, [entry.absolutePath, entry.relativePath, watchDirectoryPath, reloadNonce])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <PreviewHeader
        title={humanizeFileTitle(entry.name)}
        relativePath={entry.relativePath}
        typeLabel={entry.typeLabel}
        onReload={() => setReloadNonce((nonce) => nonce + 1)}
        onCopyPath={() => copyRelativePath(entry.relativePath)}
      />
      <div className="min-h-0 flex-1 overflow-auto bg-[color:var(--bg-app)]">
        {state.kind === 'ready' ? (
          <pre className="m-0 whitespace-pre p-3 font-mono text-[11px] leading-5 text-[color:var(--text-default)]">
            {state.content}
          </pre>
        ) : state.kind === 'loading' ? (
          <PreviewState title="Loading source…" skeleton />
        ) : state.kind === 'empty' ? (
          <PreviewState title="Empty file" body={`${entry.relativePath} has no content yet.`} />
        ) : state.kind === 'deleted' ? (
          <PreviewState
            glyph="deleted"
            title="This file isn’t on disk"
            path={entry.relativePath}
            body="It may have been removed since you selected it, or not written yet. Pick another file, or reload."
          />
        ) : (
          <PreviewState glyph="error" tone="warn" title="File unavailable" body={state.reason} />
        )}
      </div>
    </div>
  )
}

/**
 * Previews the real design artifact selected via the canvas screen switcher, dispatching by
 * type: HTML through the shared sandboxed iframe, markdown through the existing
 * rendered-markdown pane, images inline, and CSS/JS/JSON/text as read-only
 * source. There is no separate preview list — the pane only reflects the
 * selected file. Read failures surface as explicit designed states, never a void.
 */
export function DesignArtifactPreviewPane({ entry, onSubmitAnnotations, annotateSubmitLabel }: Props) {
  if (!entry) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <PreviewState
          title="Nothing to preview yet"
          body="The first file usually lands within a minute — it will render here as soon as it exists."
        />
      </div>
    )
  }

  const kind = previewKindForArtifact(entry)
  const watchDirectoryPath = parentPath(entry.absolutePath)

  if (kind === 'html') {
    return (
      <HtmlArtifactFrame
        absolutePath={entry.absolutePath}
        relativePath={entry.relativePath}
        watchDirectoryPath={watchDirectoryPath}
        onSubmitAnnotations={onSubmitAnnotations}
        annotateSubmitLabel={annotateSubmitLabel}
      />
    )
  }

  if (kind === 'markdown') {
    return (
      <RenderedBriefPane
        briefPath={entry.absolutePath}
        watchDirectoryPath={watchDirectoryPath}
        title={humanizeFileTitle(entry.name)}
        unavailableTitle="Notes unavailable"
        missingReason={`${entry.relativePath} is missing on disk.`}
        emptyReason={`${entry.relativePath} is empty.`}
        copyPathLabel={entry.relativePath}
      />
    )
  }

  if (kind === 'image') {
    return <ImageArtifactView entry={entry} />
  }

  if (kind === 'source') {
    return <SourceArtifactView entry={entry} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      <PreviewHeader
        title={humanizeFileTitle(entry.name)}
        relativePath={entry.relativePath}
        typeLabel={entry.typeLabel}
        onCopyPath={() => copyRelativePath(entry.relativePath)}
      />
      <PreviewState
        title="Preview not supported"
        path={entry.relativePath}
        body="This file can’t be previewed here. Open it from the workspace folder instead."
      />
    </div>
  )
}
