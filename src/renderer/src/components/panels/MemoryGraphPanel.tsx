import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import MemoryPreviewModal from '../memory/MemoryPreviewModal'
import MemoryGraphCanvas, {
  MemoryGraphCanvasHandle,
} from '../memory/MemoryGraphCanvas'
import {
  MemoryGraphLegend,
  MemoryGraphTooltip,
} from '../memory/MemoryGraphHud'

type CursorPoint = { x: number; y: number }

const PANEL_BG = 'rgba(10, 10, 30, 0.85)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.08)'

export default function MemoryGraphPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))

  const [indexResult, setIndexResult] = useState<MemoryGraphIndexResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<MemoryGraphNode | null>(null)
  const [hoverPoint, setHoverPoint] = useState<CursorPoint | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryPreviewResult | null>(null)

  const canvasRef = useRef<MemoryGraphCanvasHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const hasAutoFitRef = useRef(false)

  const loadGraph = useCallback(async () => {
    setLoading(true)
    hasAutoFitRef.current = false
    try {
      const result = await window.api.memoryIndex({
        workspaceRoot: workspace?.folderPath ?? null,
        relativeRoot: workspace?.memory.relativeRoot ?? null,
      })
      setIndexResult(result)
      setSelectedId(null)
      setPreview(null)
      setHovered(null)
    } finally {
      setLoading(false)
    }
  }, [workspace?.folderPath, workspace?.memory.relativeRoot])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  const allNodes = indexResult?.ok ? indexResult.nodes : []
  const allEdges = indexResult?.ok ? indexResult.edges : []

  // Match set drives search dimming; null disables it entirely.
  const matchIds = useMemo<Set<string> | null>(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return null
    const ids = new Set<string>()
    for (const node of allNodes) {
      const haystack = [
        node.name,
        node.relativePath,
        node.title ?? '',
        node.type ?? '',
        ...(node.tags ?? []),
      ]
        .join(' ')
        .toLowerCase()
      if (haystack.includes(trimmed)) ids.add(node.id)
    }
    return ids
  }, [allNodes, query])

  // Auto-fit on first successful load.
  useEffect(() => {
    if (hasAutoFitRef.current) return
    if (loading) return
    if (allNodes.length === 0) return
    const handle = window.setTimeout(() => {
      canvasRef.current?.fitToView()
      hasAutoFitRef.current = true
    }, 1100)
    return () => window.clearTimeout(handle)
  }, [loading, allNodes.length])

  const fetchPreview = useCallback(
    async (node: MemoryGraphNode) => {
      setPreview(null)
      const result = await window.api.memoryReadPreview({
        workspaceRoot: workspace?.folderPath ?? null,
        relativeRoot: workspace?.memory.relativeRoot ?? null,
        relativePath: node.relativePath,
      })
      setPreview(result)
    },
    [workspace?.folderPath, workspace?.memory.relativeRoot]
  )

  const openNode = useCallback(
    (node: MemoryGraphNode) => {
      setSelectedId(node.id)
      void fetchPreview(node)
    },
    [fetchPreview]
  )

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectedId) return
      const target = event.target as HTMLElement | null
      const isTextInput =
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false)
      if (event.key === '/' && !isTextInput) {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }
      if (isTextInput) return
      if (event.key === 'f' || event.key === 'F') canvasRef.current?.fitToView()
      else if (event.key === 'r' || event.key === 'R') canvasRef.current?.resetView()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId])

  const selectedNode = selectedId ? allNodes.find((n) => n.id === selectedId) ?? null : null
  const showCanvas =
    !!workspace?.memory.relativeRoot && !loading && indexResult?.ok && allNodes.length > 0

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: '#0a0a1a', color: '#e0e0e0' }}
    >
      {/* Floating top bar — glassmorphism, sits over the canvas. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-end gap-2 p-3">
        <div
          className="pointer-events-auto flex items-center gap-1.5 rounded-lg p-1"
          style={{
            background: PANEL_BG,
            border: PANEL_BORDER,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <div className="relative">
            <span
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-white/45"
              aria-hidden
            >
              ⌕
            </span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes…"
              className="h-8 w-64 rounded-md bg-transparent pl-7 pr-7 text-xs text-white placeholder-white/40 outline-none transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.12)' }}
            />
            <kbd
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 font-mono text-[10px] text-white/45"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              /
            </kbd>
          </div>
          <button
            type="button"
            onClick={() => void loadGraph()}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            title="Refresh index"
            aria-label="Refresh memory index"
          >
            <span aria-hidden>↻</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {!workspace?.memory.relativeRoot ? (
          <MemoryNotice
            tone="info"
            title="Memory is not configured"
            message="Set a workspace-relative memory path in Settings → Memory to render the graph. Multicode never guesses a folder for you."
          />
        ) : loading ? (
          <LoadingOverlay />
        ) : indexResult && !indexResult.ok ? (
          <MemoryNotice
            tone="error"
            title="Memory folder unavailable"
            message={indexResult.message}
            hint="Do not guess another folder — check Settings or create the configured path."
          />
        ) : allNodes.length === 0 ? (
          <MemoryNotice
            tone="info"
            title={query.trim() ? 'No matches' : 'No memory files found'}
            message={
              query.trim()
                ? `No notes match "${query.trim()}".`
                : 'The configured memory folder is empty. Add a Markdown file to start building the graph.'
            }
          />
        ) : (
          <div className="relative flex-1">
            <MemoryGraphCanvas
              ref={canvasRef}
              nodes={allNodes}
              edges={allEdges}
              matchIds={matchIds}
              onSelectNode={openNode}
              onHoverNode={(node, point) => {
                setHovered(node)
                setHoverPoint(point)
              }}
            />
            {showCanvas ? <MemoryGraphLegend nodes={allNodes} /> : null}
            {hovered && hoverPoint ? (
              <MemoryGraphTooltip node={hovered} x={hoverPoint.x} y={hoverPoint.y} />
            ) : null}
          </div>
        )}
      </div>

      {selectedNode ? (
        <MemoryPreviewModal
          workspaceId={workspaceId}
          node={selectedNode}
          preview={preview}
          nodes={allNodes}
          edges={allEdges}
          onNavigate={openNode}
          onClose={() => {
            setSelectedId(null)
            setPreview(null)
          }}
        />
      ) : null}
    </div>
  )
}

function MemoryNotice({
  title,
  message,
  hint,
  tone,
}: {
  title: string
  message: string
  hint?: string
  tone: 'info' | 'error'
}) {
  return (
    <div className="flex h-full w-full items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <div className="mb-3 text-xl text-white/40" aria-hidden>
          {tone === 'error' ? '!' : '◌'}
        </div>
        <div className="text-sm font-semibold text-white">{title}</div>
        {tone === 'error' ? (
          <div
            className="mx-auto mt-3 max-w-md rounded px-3 py-2 text-left font-mono text-[11px] text-white/65"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            {message}
          </div>
        ) : (
          <div className="mt-2 text-xs leading-6 text-white/55">{message}</div>
        )}
        {hint ? <div className="mt-3 text-xs leading-6 text-white/55">{hint}</div> : null}
      </div>
    </div>
  )
}

function LoadingOverlay() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex items-center gap-3 text-xs text-white/60">
        <span
          className="h-3 w-3 animate-pulse rounded-full"
          style={{ background: '#69f0ae', boxShadow: '0 0 12px #69f0ae' }}
          aria-hidden
        />
        <span>Indexing memory…</span>
      </div>
    </div>
  )
}
