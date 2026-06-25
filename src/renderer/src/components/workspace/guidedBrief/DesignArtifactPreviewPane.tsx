import { useEffect, useState, type ReactNode } from 'react'
import { TruncatedText } from '../../ui'
import { parentPath } from '../../../utils/paths'
import { HtmlArtifactFrame } from './MockupPreviewPane'
import { RenderedBriefPane } from './RenderedBriefPane'
import { previewKindForArtifact, type DesignArtifactEntry } from './designArtifacts'

type Props = {
  /** The artifact selected in DesignFilesPane, or null when nothing is selected. */
  entry: DesignArtifactEntry | null
}

function CenteredState({
  title,
  body,
  tone = 'neutral',
}: {
  title: string
  body: ReactNode
  tone?: 'neutral' | 'warn'
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span
        className={`text-[12px] font-semibold ${
          tone === 'warn' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {title}
      </span>
      <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{body}</span>
    </div>
  )
}

function PreviewHeader({
  relativePath,
  typeLabel,
  onReload,
  onCopyPath,
}: {
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
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2">
      <TruncatedText
        as="span"
        text={relativePath}
        className="font-mono text-[11px] text-[color:var(--text-muted)]"
      />
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-[color:var(--text-muted)]">{typeLabel}</span>
        {onReload ? (
          <button
            type="button"
            onClick={onReload}
            className="
              inline-flex h-6 items-center rounded-sm px-1.5 text-[11px] text-[color:var(--text-muted)]
              transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
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
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
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

type ImageState =
  | { kind: 'loading' }
  | { kind: 'ready'; dataUrl: string }
  | { kind: 'unavailable'; reason: string }

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
          setState({ kind: 'unavailable', reason: `${entry.relativePath} is missing on disk.` })
          return
        }
        const dataUrl = await window.api.readImageDataUrl(entry.absolutePath)
        if (cancelled) return
        if (!dataUrl) {
          setState({ kind: 'unavailable', reason: `${entry.relativePath} could not be read as an image.` })
          return
        }
        setState({ kind: 'ready', dataUrl })
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'unavailable',
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
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
            Loading image…
          </div>
        ) : (
          <CenteredState tone="warn" title="Image unavailable" body={state.reason} />
        )}
      </div>
    </div>
  )
}

type SourceState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'empty' }
  | { kind: 'unavailable'; reason: string }

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
          setState({ kind: 'unavailable', reason: `${entry.relativePath} is missing on disk.` })
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
          kind: 'unavailable',
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
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
            Loading source…
          </div>
        ) : state.kind === 'empty' ? (
          <CenteredState title="Empty file" body={`${entry.relativePath} is empty.`} />
        ) : (
          <CenteredState tone="warn" title="File unavailable" body={state.reason} />
        )}
      </div>
    </div>
  )
}

/**
 * Previews the real design artifact selected in DesignFilesPane, dispatching by
 * type: HTML through the shared sandboxed iframe, markdown through the existing
 * rendered-markdown pane, images inline, and CSS/JS/JSON/text as read-only
 * source. There is no separate preview list — the pane only reflects the
 * selected file. Read failures surface as explicit unavailable states.
 */
export function DesignArtifactPreviewPane({ entry }: Props) {
  if (!entry) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <CenteredState
          title="No file selected"
          body="Pick a file in Design files to preview it here."
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
      />
    )
  }

  if (kind === 'markdown') {
    return (
      <RenderedBriefPane
        briefPath={entry.absolutePath}
        watchDirectoryPath={watchDirectoryPath}
        title={entry.name}
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
        relativePath={entry.relativePath}
        typeLabel={entry.typeLabel}
        onCopyPath={() => copyRelativePath(entry.relativePath)}
      />
      <CenteredState
        title="Preview not supported"
        body={
          <>
            <span className="font-mono">{entry.relativePath}</span> can’t be previewed here. Open it
            from the workspace folder instead.
          </>
        }
      />
    </div>
  )
}
