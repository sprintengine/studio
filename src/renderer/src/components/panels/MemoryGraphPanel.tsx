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
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'

type CursorPoint = { x: number; y: number }

const PANEL_BG = 'rgba(10, 10, 30, 0.85)'
const PANEL_BORDER = '1px solid rgba(255, 255, 255, 0.08)'

export default function MemoryGraphPanel({ workspaceId }: { workspaceId: string }) {
  const workspaceFolderPath = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.folderPath
  )
  const workspaceMemoryRelativeRoot = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.memory.relativeRoot
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const knowledgeConfig = useMemo(
    () => resolveProjectKnowledgeConfig(
      workspaceFolderPath,
      projectKnowledgeRoots,
      workspaceMemoryRelativeRoot
    ),
    [workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot]
  )

  const [indexResult, setIndexResult] = useState<MemoryGraphIndexResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<MemoryGraphNode | null>(null)
  const [hoverPoint, setHoverPoint] = useState<CursorPoint | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryPreviewResult | null>(null)
  const [activitySynapses, setActivitySynapses] = useState<MemoryActivitySynapse[]>([])
  const [activityStatus, setActivityStatus] = useState<MemoryActivityStatus | null>(null)
  const [latestActivityEvent, setLatestActivityEvent] = useState<MemoryActivityEvent | null>(null)
  const [activityNonce, setActivityNonce] = useState(0)

  const canvasRef = useRef<MemoryGraphCanvasHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.memoryIndex({
        workspaceRoot: knowledgeConfig?.projectRoot ?? null,
        relativeRoot: knowledgeConfig?.relativeRoot ?? null,
      })
      setIndexResult(result)
      setSelectedId(null)
      setPreview(null)
      setHovered(null)
    } finally {
      setLoading(false)
    }
  }, [knowledgeConfig?.projectRoot, knowledgeConfig?.relativeRoot])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  // Subscribe to live activity events and synapse snapshots. The watcher is
  // started here lazily — opening the panel implies you want to see activity.
  useEffect(() => {
    const workspaceRoot = knowledgeConfig?.projectRoot
    const memoryRoot = knowledgeConfig?.relativeRoot
    if (!workspaceRoot || !memoryRoot) {
      setActivitySynapses([])
      setActivityStatus(null)
      setLatestActivityEvent(null)
      return
    }

    let cancelled = false

    const refreshStatus = () => {
      void window.api
        .memoryActivityGetStatus({ workspaceRoot })
        .then((status) => {
          if (!cancelled) setActivityStatus(status)
        })
    }

    const refreshSynapses = () => {
      void window.api
        .memoryActivityGetSynapses({ workspaceRoot })
        .then((synapses) => {
          if (!cancelled) setActivitySynapses(synapses)
        })
    }

    void window.api.memoryActivityStartWatching({ workspaceRoot, memoryRelativeRoot: memoryRoot })
    refreshStatus()
    refreshSynapses()

    const offEvent = window.api.onMemoryActivityEvent((event) => {
      if (cancelled) return
      if (event.workspaceRoot !== workspaceRoot) return
      setLatestActivityEvent(event)
      setActivityNonce((n) => n + 1)
      // The synapse list is keyed by src||dst — update in place rather than
      // refetching every event.
      setActivitySynapses((prev) => {
        if (!event.prevNodeId || event.prevNodeId === event.nodeId) return prev
        const next = prev.slice()
        const idx = next.findIndex(
          (s) => s.src === event.prevNodeId && s.dst === event.nodeId
        )
        const synapse: MemoryActivitySynapse = {
          src: event.prevNodeId,
          dst: event.nodeId,
          count: event.synapseCount,
          lastTs: event.ts,
        }
        if (idx >= 0) next[idx] = synapse
        else next.push(synapse)
        return next
      })
    })

    const offStatus = window.api.onMemoryActivityStatus((status) => {
      if (cancelled) return
      if (status.workspaceRoot !== workspaceRoot) return
      setActivityStatus(status)
    })

    const offSynapses = window.api.onMemoryActivitySynapses((payload) => {
      if (cancelled) return
      if (payload.workspaceRoot !== workspaceRoot) return
      setActivitySynapses(payload.synapses)
    })

    return () => {
      cancelled = true
      offEvent()
      offStatus()
      offSynapses()
    }
  }, [knowledgeConfig?.projectRoot, knowledgeConfig?.relativeRoot])

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

  const fetchPreview = useCallback(
    async (node: MemoryGraphNode) => {
      setPreview(null)
      const result = await window.api.memoryReadPreview({
        workspaceRoot: knowledgeConfig?.projectRoot ?? null,
        relativeRoot: knowledgeConfig?.relativeRoot ?? null,
        relativePath: node.relativePath,
      })
      setPreview(result)
    },
    [knowledgeConfig?.projectRoot, knowledgeConfig?.relativeRoot]
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
    !!knowledgeConfig?.relativeRoot && !loading && indexResult?.ok && allNodes.length > 0

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
            aria-label="Refresh knowledge index"
          >
            <span aria-hidden>↻</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {!knowledgeConfig?.relativeRoot ? (
          <MemoryNotice
            tone="info"
            title="Knowledge Graph is not configured"
            message="Set a project-relative knowledge path in Settings → Knowledge to render the graph. Multicode never guesses a folder for you."
          />
        ) : loading ? (
          <LoadingOverlay />
        ) : indexResult && !indexResult.ok ? (
          <MemoryNotice
            tone="error"
            title="Knowledge folder unavailable"
            message={indexResult.message}
            hint="Do not guess another folder — check Settings or create the configured path."
          />
        ) : allNodes.length === 0 ? (
          <MemoryNotice
            tone="info"
            title={query.trim() ? 'No matches' : 'No knowledge files found'}
            message={
              query.trim()
                ? `No notes match "${query.trim()}".`
                : 'The configured knowledge folder is empty. Add a Markdown file to start building the graph.'
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
              synapses={activitySynapses}
              latestEvent={latestActivityEvent}
              eventNonce={activityNonce}
            />
            {showCanvas ? <MemoryGraphLegend nodes={allNodes} /> : null}
            {showCanvas && activityStatus ? (
              <MemoryActivityStatusBadge status={activityStatus} />
            ) : null}
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
        <span>Indexing knowledge…</span>
      </div>
    </div>
  )
}

function MemoryActivityStatusBadge({ status }: { status: MemoryActivityStatus }) {
  // Three states the user needs to distinguish at a glance:
  //   - Tracking off: hook isn't installed; nothing is being recorded.
  //   - Tracking idle: installed and watching but nothing's happened recently.
  //   - Tracking live: a recent event landed; pulse the indicator.
  const isLive = status.lastEventAt !== null && Date.now() - status.lastEventAt < 5000
  const dotColor = !status.isInstalled
    ? 'rgba(255,255,255,0.35)'
    : isLive
      ? '#22d3ee'
      : '#69f0ae'
  const labelTone = status.isInstalled ? 'text-white/75' : 'text-white/45'

  return (
    <div
      className="pointer-events-none absolute bottom-3 left-3 z-10 select-none"
      role="status"
      aria-live="polite"
    >
      <div
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px]"
        style={{
          background: 'rgba(10, 10, 30, 0.78)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        }}
      >
        <span
          className={`h-2 w-2 rounded-full ${isLive ? 'animate-pulse' : ''}`}
          style={{
            background: dotColor,
            boxShadow: status.isInstalled ? `0 0 8px ${dotColor}` : 'none',
          }}
          aria-hidden
        />
        {!status.isInstalled ? (
          <span className={labelTone}>Activity tracking off</span>
        ) : (
          <span className={labelTone}>
            <span className="font-semibold text-white/85">{status.sessionsRecorded}</span>{' '}
            session{status.sessionsRecorded === 1 ? '' : 's'}
            <span className="mx-1.5 text-white/25">·</span>
            <span className="font-semibold text-white/85">{status.eventsToday}</span> today
            <span className="mx-1.5 text-white/25">·</span>
            <span className="font-semibold text-white/85">{status.totalEvents}</span> total
          </span>
        )}
      </div>
    </div>
  )
}
