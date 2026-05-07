import React, { useEffect, useMemo, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import { renderMarkdown } from '../../utils/markdown'
import { TYPE_COLORS, bucketForNode } from './MemoryGraphCanvas'

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

const PANEL_BG = 'rgba(10, 10, 30, 0.85)'
const BORDER = '1px solid rgba(255, 255, 255, 0.08)'

export default function MemoryPreviewModal({
  workspaceId,
  node,
  preview,
  nodes,
  edges,
  onNavigate,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
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
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
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
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-4"
      style={{ background: 'rgba(2, 2, 8, 0.72)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-preview-title"
        tabIndex={-1}
        className="flex max-h-[86vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-2xl shadow-2xl outline-none"
        style={{
          background: PANEL_BG,
          border: BORDER,
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          color: '#e0e0e0',
        }}
      >
        <header
          className="flex shrink-0 items-start justify-between gap-3 px-6 pb-4 pt-5"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  background: hexWithAlpha(color, 0.15),
                  color,
                  border: `1px solid ${hexWithAlpha(color, 0.4)}`,
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                  aria-hidden
                />
                {bucket}
              </span>
              {node.tags?.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full px-2 py-0.5 text-[10px] text-white/65"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  {tag}
                </span>
              ))}
            </div>
            <h2
              id="memory-preview-title"
              className="mt-2 truncate text-xl font-semibold text-white"
            >
              {title}
            </h2>
            <div className="mt-0.5 truncate font-mono text-[11px] text-white/45">{path}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canOpen ? (
              <button
                type="button"
                onClick={onOpenInEditor}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white/85 transition-colors hover:text-white"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
              >
                Open in editor
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close preview"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
          {!preview ? (
            <ModalNotice message="Loading preview…" />
          ) : !preview.ok ? (
            <div
              className="rounded-md border-l-2 px-4 py-3 text-sm leading-6 text-rose-200"
              style={{ borderColor: '#ff5252', background: 'rgba(255,82,82,0.08)' }}
            >
              {preview.message}
            </div>
          ) : preview.previewKind === 'markdown' ? (
            <article className="mx-auto max-w-[760px] memory-markdown">
              {renderMarkdown(preview.content)}
            </article>
          ) : preview.previewKind === 'text' ? (
            <pre
              className="m-0 overflow-x-auto rounded-md p-4 font-mono text-xs leading-5 text-white/85"
              style={{ background: 'rgba(0,0,0,0.35)', border: BORDER }}
            >
              {preview.content}
            </pre>
          ) : preview.previewKind === 'image' ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <img
                src={preview.dataUrl}
                alt={preview.node.name}
                className="max-h-[68vh] max-w-full object-contain"
                draggable={false}
              />
            </div>
          ) : preview.previewKind === 'unsupported' ? (
            <ModalNotice message={preview.message} />
          ) : null}
        </div>

        {related.length > 0 ? (
          <footer
            className="shrink-0 px-6 py-4"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/45">
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
                    className="group flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-white/85 transition-all hover:text-white"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.10)',
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full transition-shadow"
                      style={{
                        background: targetColor,
                        boxShadow: `0 0 6px ${targetColor}`,
                      }}
                      aria-hidden
                    />
                    {label}
                  </button>
                )
              })}
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

function ModalNotice({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-white/60">
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
