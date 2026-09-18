import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import MemoryPreviewPane from '../memory/MemoryPreviewPane'
import MemoryGraphCanvas, { MemoryGraphCanvasHandle } from '../memory/MemoryGraphCanvas'
import { MemoryGraphLegend, MemoryGraphTooltip } from '../memory/MemoryGraphHud'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import {
  EmptyState,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  KbdChord,
  LoadingOverlay,
  PanelHeader,
  RefreshIcon,
  StatusDot,
} from '../ui'
import { Tooltip } from '../ui/Tooltip'
import { KnowledgeGraphSettingsIcon } from '../AppIcons'

type CursorPoint = { x: number; y: number }

export default function MemoryGraphPanel({ workspaceId }: { workspaceId: string }) {
  const workspaceFolderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath)
  const workspaceMemoryRelativeRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.memory.relativeRoot,
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const knowledgeConfig = useMemo(
    () => resolveProjectKnowledgeConfig(workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot),
    [workspaceFolderPath, projectKnowledgeRoots, workspaceMemoryRelativeRoot],
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
  // The `/` shortcut focuses the search field through its wrapper: the kit's
  // `InboxSearchInput` owns the input and hands no ref back, so the band holds
  // the ref and reaches the one `<input>` inside it.
  const searchInputRef = useRef<HTMLDivElement>(null)

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
      void window.api.memoryActivityGetStatus({ workspaceRoot }).then((status) => {
        if (!cancelled) setActivityStatus(status)
      })
    }

    const refreshSynapses = () => {
      void window.api.memoryActivityGetSynapses({ workspaceRoot }).then((synapses) => {
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
        const idx = next.findIndex((s) => s.src === event.prevNodeId && s.dst === event.nodeId)
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
      const haystack = [node.name, node.relativePath, node.title ?? '', node.type ?? '', ...(node.tags ?? [])]
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
    [knowledgeConfig?.projectRoot, knowledgeConfig?.relativeRoot],
  )

  const openNode = useCallback(
    (node: MemoryGraphNode) => {
      setSelectedId(node.id)
      void fetchPreview(node)
    },
    [fetchPreview],
  )

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectedId) return
      const target = event.target as HTMLElement | null
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false)
      if (event.key === '/' && !isTextInput) {
        event.preventDefault()
        searchInputRef.current?.querySelector('input')?.focus()
        return
      }
      if (isTextInput) return
      if (event.key === 'f' || event.key === 'F') canvasRef.current?.fitToView()
      else if (event.key === 'r' || event.key === 'R') canvasRef.current?.resetView()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId])

  const selectedNode = selectedId ? (allNodes.find((n) => n.id === selectedId) ?? null) : null
  const showCanvas = !!knowledgeConfig?.relativeRoot && !loading && indexResult?.ok && allNodes.length > 0

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      {/* The panel used to float its controls over the canvas in a pill at
          `p-3` and name itself nowhere — so the one row a person scans to know
          which panel they are in was missing here, and the tool sat at a
          different height from every sibling (2112). Identity row first, then
          the search band that carries the panel's one rule; the canvas starts
          below it, full-bleed as before. */}
      <PanelHeader
        title="Knowledge Graph"
        count={allNodes.length}
        primaryAction={
          <Tooltip content="Refresh index" placement="bottom">
            <IconButton aria-label="Refresh knowledge index" onClick={() => void loadGraph()}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        }
        divider={false}
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
        {/* The kit's search field and chord (2026-09-02 audit) — not a bare
            `<input outline-none>` with a `⌕` character for a glyph and a hand
            `<kbd>`. The wrapper carries the ref the `/` shortcut focuses. */}
        <div ref={searchInputRef} className="flex min-w-0 flex-1">
          <InboxSearchInput value={query} onChange={setQuery} ariaLabel="Search notes" placeholder="Search notes…" />
        </div>
        <KbdChord keys={['/']} ariaLabel="Slash focuses search" className="shrink-0" />
      </div>

      <div className="relative flex min-h-0 flex-1">
        {!knowledgeConfig?.relativeRoot ? (
          <MemoryNotice
            tone="info"
            title="Knowledge Graph is not configured"
            message="Set a project-relative knowledge path in Settings → Knowledge to render the graph. A folder is never guessed for you."
          />
        ) : loading ? (
          <LoadingOverlay label="Indexing knowledge…" />
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
            {showCanvas && activityStatus ? <MemoryActivityStatusBadge status={activityStatus} /> : null}
            {hovered && hoverPoint ? <MemoryGraphTooltip node={hovered} x={hoverPoint.x} y={hoverPoint.y} /> : null}
          </div>
        )}
      </div>

      {selectedNode ? (
        <MemoryPreviewPane
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
  // Two of the kit's data-state idioms, not one hand-rolled card with `!` / `◌`
  // characters for glyphs and `text-xl/sm/xs` off the type ramp (2026-09-02
  // audit): a failure is the error card with the raw message behind "Show
  // details"; anything else is the empty state.
  if (tone === 'error') {
    return (
      <div className="flex h-full w-full items-center justify-center px-6">
        <InlineNotice tone="error" title={title} hint={hint} detail={message} className="w-full max-w-md" />
      </div>
    )
  }
  return (
    <EmptyState
      className="w-full"
      glyph={<KnowledgeGraphSettingsIcon className="size-icon-lg" />}
      title={title}
      body={hint ? `${message} ${hint}` : message}
    />
  )
}

function MemoryActivityStatusBadge({ status }: { status: MemoryActivityStatus }) {
  // Three states the user needs to distinguish at a glance:
  //   - Tracking off: hook isn't installed; nothing is being recorded.
  //   - Tracking idle: installed and watching but nothing's happened recently.
  //   - Tracking live: a recent event landed; pulse the indicator.
  const isLive = status.lastEventAt !== null && Date.now() - status.lastEventAt < 5000
  const dotTone = !status.isInstalled ? 'neutral' : isLive ? 'accent' : 'good'
  const labelTone = status.isInstalled ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-muted)]'

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 select-none" role="status" aria-live="polite">
      {/* `StatusDot` + the words, on a quiet surface ground so it stays legible
          over the canvas — not a bordered pill (badge/component.md; 2026-09-02
          audit). */}
      <div className="flex items-center gap-2 rounded-sm bg-[color:var(--bg-surface)] px-2 py-1 text-micro">
        <StatusDot tone={dotTone} pulse={isLive} />
        {!status.isInstalled ? (
          <span className={labelTone}>Activity tracking off</span>
        ) : (
          <span className={labelTone}>
            <span className="font-semibold text-[color:var(--text-strong)]">{status.sessionsRecorded}</span> session
            {status.sessionsRecorded === 1 ? '' : 's'}
            <span className="mx-1.5 text-[color:var(--text-disabled)]">·</span>
            <span className="font-semibold text-[color:var(--text-strong)]">{status.eventsToday}</span> today
            <span className="mx-1.5 text-[color:var(--text-disabled)]">·</span>
            <span className="font-semibold text-[color:var(--text-strong)]">{status.totalEvents}</span> total
          </span>
        )}
      </div>
    </div>
  )
}
