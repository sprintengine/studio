import React, { useEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import { renderMarkdown } from '../../utils/markdown'
import { TYPE_COLORS, bucketForNode } from './MemoryGraphCanvas'
import { Tooltip } from '../ui/Tooltip'

type Props = {
  workspaceId: string
  /** The currently selected node (always one of `nodes`). */
  node: MemoryGraphNode
  /** Preview body — markdown body, plain text, or null while loading / on error. */
  preview: MemoryPreviewResult | null
  /** Full set of nodes so we can resolve Related pills. */
  nodes: MemoryGraphNode[]
  /** All edges so we can compute outgoing + incoming Related when frontmatter is empty. */
  edges: MemoryGraphEdge[]
  onNavigate: (node: MemoryGraphNode) => void
  onClose: () => void
}

export default function MemoryPreviewPane({
  workspaceId,
  node,
  preview,
  nodes,
  edges,
  onNavigate,
  onClose,
}: Props) {
  const paneRef = useRef<HTMLElement>(null)
  const openFile = useWorkspaceStore((s) => s.openFile)

  // Build the Related list: frontmatter `related` + outgoing edges + incoming edges,
  // de-duplicated, in that priority order so explicit links lead.
  const related = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n] as const))
    const seen = new Set<string>()
    const result: MemoryGraphNode[] = []
    const push = (id: string | undefined) => {
      if (!id || id === node.id || seen.has(id)) return
      const found = byId.get(id)
      if (!found) return
      seen.add(id)
      result.push(found)
    }
    node.related?.forEach(push)
    edges.forEach((edge) => {
      if (edge.source === node.id) push(edge.target)
    })
    edges.forEach((edge) => {
      if (edge.target === node.id) push(edge.source)
    })
    return result
  }, [node, nodes, edges])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const bucket = bucketForNode(node)
  const color = TYPE_COLORS[bucket] ?? TYPE_COLORS.default
  const title = node.title?.trim() || node.name
  const path = node.relativePath
  const canOpen = preview?.ok && (preview.previewKind === 'markdown' || preview.previewKind === 'text' || preview.previewKind === 'image')

  const onOpenInEditor = () => {
    if (!preview?.ok) return
    if (preview.previewKind === 'markdown' || preview.previewKind === 'text') {
      openFile(workspaceId, preview.node.path, preview.node.name, preview.content)
      focusOrAddFileTab(workspaceId, preview.node.path, preview.node.name)
      onClose()
    } else if (preview.previewKind === 'image') {
      openFile(workspaceId, preview.node.path, preview.node.name, '')
      focusOrAddFileTab(workspaceId, preview.node.path, preview.node.name)
      onClose()
    }
  }

  return (
    <aside
      ref={paneRef}
      role="complementary"
      aria-label="Knowledge node preview"
      className="absolute inset-y-0 right-0 z-20 flex w-[min(560px,90%)] flex-col border-l border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-strong)] shadow-[var(--shadow-drawer)]"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--border-default)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: hexWithAlpha(color, 0.35),
                background: hexWithAlpha(color, 0.10),
                color,
              }}
            >
              <span
                className="h-[6px] w-[6px] rounded-full"
                style={{ background: color }}
                aria-hidden
              />
              {bucket}
            </span>
            {node.tags?.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[11px] text-[color:var(--text-muted)]"
              >
                {tag}
              </span>
            ))}
          </div>
          <h2 className="mt-2 truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
            {title}
          </h2>
          <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-[color:var(--text-disabled)]">
            {path}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canOpen ? (
            <button
              type="button"
              onClick={onOpenInEditor}
              className="h-8 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 text-[12px] font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
            >
              Open in editor
            </button>
          ) : null}
          <Tooltip content="Close (Esc)">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
            >
              <svg className="icon-md" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {!preview ? (
          <PaneNotice message="Loading preview…" />
        ) : !preview.ok ? (
          <div className="rounded-[5px] border-l-2 border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] px-4 py-3 text-[13px] leading-6 text-[color:var(--tone-error)]">
            {preview.message}
          </div>
        ) : preview.previewKind === 'markdown' ? (
          <article className="memory-markdown">
            {renderMarkdown(preview.content)}
          </article>
        ) : preview.previewKind === 'text' ? (
          <pre className="m-0 overflow-x-auto rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-4 font-mono text-[12px] leading-5 text-[color:var(--text-default)]">
            {preview.content}
          </pre>
        ) : preview.previewKind === 'image' ? (
          <div className="flex min-h-[240px] items-center justify-center">
            <img
              src={preview.dataUrl}
              alt={preview.node.name}
              className="max-h-[60vh] max-w-full object-contain"
              draggable={false}
            />
          </div>
        ) : preview.previewKind === 'unsupported' ? (
          <PaneNotice message={preview.message} />
        ) : null}
      </div>

      {related.length > 0 ? (
        <footer className="shrink-0 border-t border-[color:var(--border-default)] px-5 py-4">
          <div className="mb-2 text-[11px] font-semibold text-[color:var(--text-disabled)]">
            Related
          </div>
          <div className="flex flex-wrap gap-1.5">
            {related.map((target) => {
              const targetBucket = bucketForNode(target)
              const targetColor = TYPE_COLORS[targetBucket] ?? TYPE_COLORS.default
              const label = target.title?.trim() || target.name.replace(/\.mdx?$/i, '')
              return (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => onNavigate(target)}
                  className="group inline-flex items-center gap-1.5 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-[11px] text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
                >
                  <span
                    className="h-[6px] w-[6px] rounded-full"
                    style={{ background: targetColor }}
                    aria-hidden
                  />
                  {label}
                </button>
              )
            })}
          </div>
        </footer>
      ) : null}
    </aside>
  )
}

function PaneNotice({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-[13px] text-[color:var(--text-muted)]">
      {message}
    </div>
  )
}

function hexWithAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) return hex
  let r: number, g: number, b: number
  if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16)
    g = parseInt(hex.slice(3, 5), 16)
    b = parseInt(hex.slice(5, 7), 16)
  } else {
    r = parseInt(hex[1] + hex[1], 16)
    g = parseInt(hex[2] + hex[2], 16)
    b = parseInt(hex[3] + hex[3], 16)
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
