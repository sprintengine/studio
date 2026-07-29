import React from 'react'
import { Tooltip } from './Tooltip'
import { CloseIconButton } from './Buttons'
import { renderMarkdown } from '../../utils/markdown'

// FilePreviewPane — canonical inline file/artifact preview surface.
// Renders a Back affordance, the filename, an optional "Open in editor"
// jump-out, and a body that switches between markdown rendering and a
// preformatted plain-text view based on the file extension.
//
// Used by Watchtower's task-attached file preview and Sprint Engine's
// artifact preview. Both panels previously hand-rolled the same chrome
// (header pixel-for-pixel identical; only the title typography differed
// per caller).
//
// API note: caller controls title typography directly via `title` so the
// primitive doesn't have to enumerate every styling permutation. Use
// `<span className="font-mono tabular-nums">` for raw paths; use plain
// text for human-readable artifact names. The `path` prop is used for the
// hover tooltip on the title and for markdown extension detection.

type FilePreviewPaneProps = {
  /** Visible title. Caller controls typography (mono for paths, plain for
   *  artifact names). */
  title: React.ReactNode
  /** Full path. Used as the title's hover tooltip and to detect whether
   *  the body is markdown (`.md` extension). */
  path: string
  /** File contents. Rendered through the markdown pipeline when the path
   *  ends in `.md`; otherwise rendered as preformatted text. */
  content: string
  /** Back affordance — typically returns the user to the detail pane. */
  onBack: () => void
  /** Optional "Open in editor tab" handler. Hides the button when omitted. */
  onPopOut?: () => void
  /** Optional close handler. Renders the canonical top-right X so the pane
   *  keeps its dismiss affordance when the preview replaces an inspector
   *  view that had one. Back returns one level; close dismisses the pane. */
  onClose?: () => void
  /** Opt-in body override: replaces the extension-based content rendering
   *  while keeping the shared header chrome. Used for previews that manage
   *  their own scrolling (e.g. the sandboxed HTML artifact frame). */
  body?: React.ReactNode
}

const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

export function FilePreviewPane({
  title,
  path,
  content,
  onBack,
  onPopOut,
  onClose,
  body,
}: FilePreviewPaneProps) {
  const isMarkdown = path.toLowerCase().endsWith('.md')
  const renderAsMarkdown = isMarkdown && content.length <= MARKDOWN_PREVIEW_MAX_CHARS
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip content="Back">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] interactive hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              aria-label="Back"
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                <path
                  d="M10 4L6 8L10 12"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </Tooltip>
          <span className="min-w-0 truncate" title={path}>
            {title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onPopOut ? (
            <Tooltip content="Open in editor tab">
              <button
                type="button"
                onClick={onPopOut}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-semibold text-[color:var(--text-muted)] interactive hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                aria-label="Open in editor tab"
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                  <path
                    d="M9 3H13V7M13 3L7.5 8.5M6 4H4C3.45 4 3 4.45 3 5V12C3 12.55 3.45 13 4 13H11C11.55 13 12 12.55 12 12V10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Open in editor
              </button>
            </Tooltip>
          ) : null}
          {onClose ? <CloseIconButton aria-label="Close preview" onClick={onClose} /> : null}
        </div>
      </header>
      {body ? (
        <div className="flex min-h-0 flex-1 flex-col p-3">{body}</div>
      ) : (
        <div className="flex-1 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
          {renderAsMarkdown ? (
            <div className="markdown-body">{renderMarkdown(content)}</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-[color:var(--text-default)]">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
