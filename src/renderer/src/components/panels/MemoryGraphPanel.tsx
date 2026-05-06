import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import MemoryPreviewModal from '../memory/MemoryPreviewModal'
import MemoryGraphCanvas, { MemoryGraphCanvasHandle } from '../memory/MemoryGraphCanvas'
import MemoryGraphSidebar from '../memory/MemoryGraphSidebar'
import {
  MemoryGraphStats,
  MemoryGraphTooltip,
  MemoryGraphZoomHud,
} from '../memory/MemoryGraphHud'
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_PALETTE,
  ruleId,
} from '../memory/memoryGraphTypes'
import type { Camera as CameraType } from '../memory/memoryGraphTypes'
import type { MemoryGraphSettings } from '../../types/workspace'

type Coordinate = { x: number; y: number }

export default function MemoryGraphPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateMemoryGraphSettings = useWorkspaceStore((s) => s.updateMemoryGraphSettings)

  const settings: MemoryGraphSettings = workspace?.memory.graphSettings ?? DEFAULT_GRAPH_SETTINGS

  const [indexResult, setIndexResult] = useState<MemoryGraphIndexResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<MemoryGraphNode | null>(null)
  const [hoverPos, setHoverPos] = useState<Coordinate | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryPreviewResult | null>(null)
  const [camera, setCamera] = useState<CameraType>({ x: 0, y: 0, scale: 1 })

  const canvasRef = useRef<MemoryGraphCanvasHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.memoryIndex({
        workspaceRoot: workspace?.folderPath ?? null,
        relativeRoot: workspace?.memory.relativeRoot ?? null,
      })
      setIndexResult(result)
      setSelectedId(null)
      setHovered(null)
    } finally {
      setLoading(false)
    }
  }, [workspace?.folderPath, workspace?.memory.relativeRoot])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  // Seed default color rules the first time we have groups but no rules.
  useEffect(() => {
    if (!indexResult?.ok) return
    if (settings.colorRules.length > 0) return
    if (indexResult.groups.length === 0) return
    const seeded = indexResult.groups.slice(0, GRAPH_PALETTE.length).map((group, idx) => ({
      id: ruleId(),
      pattern: `path:${group}/`,
      color: GRAPH_PALETTE[idx],
    }))
    updateMemoryGraphSettings(workspaceId, { colorRules: seeded })
    // Only seed on the very first load — relying on settings.colorRules.length === 0 as the sentinel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexResult, workspaceId])

  const onSettingsChange = useCallback(
    (
      update:
        | Partial<MemoryGraphSettings>
        | ((current: MemoryGraphSettings) => Partial<MemoryGraphSettings> | MemoryGraphSettings)
    ) => {
      updateMemoryGraphSettings(workspaceId, update)
    },
    [updateMemoryGraphSettings, workspaceId]
  )

  // Build the visible graph based on filters + search.
  const { visibleNodes, visibleEdges, ghostNodes } = useMemo(() => {
    const empty = { visibleNodes: [] as MemoryGraphNode[], visibleEdges: [] as MemoryGraphEdge[], ghostNodes: [] as MemoryGraphNode[] }
    if (!indexResult?.ok) return empty
    const trimmed = query.trim().toLowerCase()

    let filtered = indexResult.nodes.slice()

    if (settings.filters.hideAttachments) {
      filtered = filtered.filter((node) => node.kind === 'markdown' || node.kind === 'text')
    }
    if (settings.filters.disabledGroups.length > 0) {
      const disabled = new Set(settings.filters.disabledGroups)
      filtered = filtered.filter((node) => !disabled.has(node.group))
    }
    if (trimmed) {
      filtered = filtered.filter((node) =>
        node.name.toLowerCase().includes(trimmed)
        || node.relativePath.toLowerCase().includes(trimmed)
        || node.group.toLowerCase().includes(trimmed)
      )
    }

    const filteredIds = new Set(filtered.map((node) => node.id))
    let edgeSet = indexResult.edges.filter((edge) => filteredIds.has(edge.source) && filteredIds.has(edge.target))

    if (settings.filters.depthFromSelection !== null && selectedId && filteredIds.has(selectedId)) {
      const depth = settings.filters.depthFromSelection
      const adj = new Map<string, Set<string>>()
      edgeSet.forEach((edge) => {
        if (!adj.has(edge.source)) adj.set(edge.source, new Set())
        if (!adj.has(edge.target)) adj.set(edge.target, new Set())
        adj.get(edge.source)?.add(edge.target)
        adj.get(edge.target)?.add(edge.source)
      })
      const allowed = new Set<string>([selectedId])
      let frontier = new Set<string>([selectedId])
      for (let i = 0; i < depth; i += 1) {
        const next = new Set<string>()
        frontier.forEach((id) => {
          adj.get(id)?.forEach((peer) => {
            if (!allowed.has(peer)) {
              next.add(peer)
              allowed.add(peer)
            }
          })
        })
        frontier = next
        if (frontier.size === 0) break
      }
      filtered = filtered.filter((node) => allowed.has(node.id))
      edgeSet = edgeSet.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
    }

    if (settings.filters.hideOrphans) {
      const linked = new Set<string>()
      edgeSet.forEach((edge) => {
        linked.add(edge.source)
        linked.add(edge.target)
      })
      filtered = filtered.filter((node) => linked.has(node.id) || node.degree > 0)
    }

    const finalIds = new Set(filtered.map((node) => node.id))
    edgeSet = edgeSet.filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target))

    let ghosts: MemoryGraphNode[] = []
    if (!settings.filters.hideUnresolved) {
      const ghostMap = new Map<string, MemoryGraphNode>()
      indexResult.unresolvedLinks.forEach((link) => {
        if (!finalIds.has(link.sourcePath)) return
        if (link.reason !== 'missing' || !link.resolvedRelativePath) return
        const id = `__unresolved__:${link.resolvedRelativePath}`
        if (ghostMap.has(id)) return
        const name = link.resolvedRelativePath.split('/').filter(Boolean).pop() ?? link.resolvedRelativePath
        ghostMap.set(id, {
          id,
          path: link.resolvedRelativePath,
          relativePath: link.resolvedRelativePath,
          name,
          kind: 'asset',
          extension: '',
          sizeBytes: 0,
          degree: 1,
          group: '(unresolved)',
        })
      })
      ghosts = [...ghostMap.values()]
      // Synthesise edges so the canvas can draw the dashed connection.
      ghosts.forEach((ghost) => {
        const target = ghost.id
        indexResult.unresolvedLinks
          .filter((link) => link.resolvedRelativePath === ghost.relativePath && finalIds.has(link.sourcePath))
          .forEach((link) => {
            edgeSet = edgeSet.concat([{
              id: `${link.sourcePath}->${target}`,
              source: link.sourcePath,
              target,
              sourcePath: link.sourcePath,
              targetPath: ghost.relativePath,
            }])
          })
      })
    }

    return { visibleNodes: filtered, visibleEdges: edgeSet, ghostNodes: ghosts }
  }, [indexResult, query, settings.filters, selectedId])

  const stats = useMemo(() => {
    if (!indexResult?.ok) {
      return { noteCount: 0, linkCount: 0, orphanCount: 0, unresolvedCount: 0, topConnected: [] }
    }
    const orphanCount = visibleNodes.filter((node) => node.degree === 0).length
    const top = [...visibleNodes].sort((a, b) => b.degree - a.degree).slice(0, 3).map((n) => n.name)
    return {
      noteCount: visibleNodes.length,
      linkCount: visibleEdges.filter((edge) => !edge.target.startsWith('__unresolved__')).length,
      orphanCount,
      unresolvedCount: indexResult.unresolvedLinks.filter((l) => l.reason === 'missing').length,
      topConnected: top,
    }
  }, [indexResult, visibleNodes, visibleEdges])

  const openPreview = useCallback(async (node: MemoryGraphNode) => {
    if (node.id.startsWith('__unresolved__')) return
    setSelectedId(node.id)
    const result = await window.api.memoryReadPreview({
      workspaceRoot: workspace?.folderPath ?? null,
      relativeRoot: workspace?.memory.relativeRoot ?? null,
      relativePath: node.relativePath,
    })
    setPreview(result)
  }, [workspace?.folderPath, workspace?.memory.relativeRoot])

  // Track hover position for the tooltip.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      setHoverPos({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    container.addEventListener('mousemove', onMove)
    return () => container.removeEventListener('mousemove', onMove)
  }, [])

  // Keyboard shortcuts (panel-scoped).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (preview) return
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
      if (event.key === 'Escape' && !isTextInput) {
        if (selectedId) {
          setSelectedId(null)
        } else if (settings.filters.depthFromSelection !== null) {
          onSettingsChange({ filters: { ...settings.filters, depthFromSelection: null } })
        }
        return
      }
      if (isTextInput) return
      if (event.key === 'f' || event.key === 'F') {
        canvasRef.current?.fitToView()
      } else if (event.key === 'r' || event.key === 'R') {
        canvasRef.current?.resetView()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [preview, selectedId, settings.filters, onSettingsChange])

  const setSidebarOpen = (open: boolean) => onSettingsChange({ sidebarOpen: open })

  const showCanvas =
    !!workspace?.memory.relativeRoot
    && !loading
    && indexResult?.ok
    && visibleNodes.length > 0

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
          <span
            className="h-1.5 w-1.5 rounded-full bg-indigo-500"
            style={{ boxShadow: '0 0 6px rgb(99 102 241 / 0.7)' }}
            aria-hidden
          />
          <span className="font-medium">Memory Graph</span>
          {workspace?.memory.relativeRoot ? (
            <span className="truncate font-mono text-[11px] text-zinc-500">
              {workspace.memory.relativeRoot}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500" aria-hidden>
              ⌕
            </span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search notes…"
              className="h-7 w-56 rounded border border-zinc-800 bg-zinc-950 pl-7 pr-7 text-xs text-zinc-200 placeholder-zinc-600 transition-colors focus:border-indigo-500 focus:outline-none"
            />
            <kbd className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-500">
              /
            </kbd>
          </div>
          <button
            type="button"
            onClick={() => void loadGraph()}
            className="flex h-7 items-center gap-1.5 rounded px-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Refresh index"
            aria-label="Refresh index"
          >
            <span aria-hidden>↻</span>
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(!settings.sidebarOpen)}
            className={`flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors ${
              settings.sidebarOpen
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
            title={settings.sidebarOpen ? 'Hide settings' : 'Show settings'}
            aria-label="Toggle settings sidebar"
            aria-pressed={settings.sidebarOpen}
          >
            <span aria-hidden>⇥</span>
            <span>Settings</span>
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div ref={containerRef} className="relative min-w-0 flex-1">
          {!workspace?.memory.relativeRoot ? (
            <MemoryNotice
              tone="info"
              title="Memory is not configured"
              message="Set a workspace-relative memory path in Settings → Memory to render the graph. Multicode never guesses a folder for you."
            />
          ) : loading ? (
            <MemoryNotice tone="info" title="Indexing memory" message="Reading local Markdown links and assets…" />
          ) : indexResult && !indexResult.ok ? (
            <MemoryNotice
              tone="error"
              title="Memory folder unavailable"
              message={indexResult.message}
              hint="Do not guess another folder — check Settings or create the configured path."
            />
          ) : indexResult?.ok && visibleNodes.length === 0 ? (
            <MemoryNotice
              tone="info"
              title={query.trim() ? 'No matches' : 'No memory files found'}
              message={
                query.trim()
                  ? `No notes match "${query.trim()}". Clear the search or adjust filters.`
                  : 'The configured memory folder is empty. Add a Markdown file to start building the graph.'
              }
            />
          ) : (
            <MemoryGraphCanvas
              ref={canvasRef}
              nodes={visibleNodes}
              edges={visibleEdges}
              unresolvedNodes={ghostNodes}
              display={settings.display}
              forces={settings.forces}
              colorRules={settings.colorRules}
              hoveredId={hovered?.id ?? null}
              selectedId={selectedId}
              onHoverNode={setHovered}
              onSelectNode={(node) => void openPreview(node)}
              onCameraChange={setCamera}
            />
          )}

          {showCanvas ? (
            <>
              <MemoryGraphStats {...stats} />
              <MemoryGraphZoomHud
                scale={camera.scale}
                onZoomIn={() => canvasRef.current?.zoomBy(1.2)}
                onZoomOut={() => canvasRef.current?.zoomBy(1 / 1.2)}
                onFit={() => canvasRef.current?.fitToView()}
                onReset={() => canvasRef.current?.resetView()}
              />
              {hovered && hoverPos ? (
                <MemoryGraphTooltip node={hovered} x={hoverPos.x} y={hoverPos.y} />
              ) : null}
            </>
          ) : null}
        </div>

        {settings.sidebarOpen ? (
          <MemoryGraphSidebar
            settings={settings}
            groups={indexResult?.ok ? indexResult.groups : []}
            onSettingsChange={onSettingsChange}
            onClose={() => setSidebarOpen(false)}
          />
        ) : null}
      </div>

      {preview ? (
        <MemoryPreviewModal
          workspaceId={workspaceId}
          result={preview}
          onClose={() => setPreview(null)}
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
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <div className="mb-3 text-xl text-zinc-700" aria-hidden>
          {tone === 'error' ? '!' : '◌'}
        </div>
        <div className="text-sm font-semibold text-zinc-100">{title}</div>
        {tone === 'error' ? (
          <div className="mx-auto mt-3 max-w-md rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-left font-mono text-[11px] text-zinc-400">
            {message}
          </div>
        ) : (
          <div className="mt-2 text-xs leading-6 text-zinc-500">{message}</div>
        )}
        {hint ? <div className="mt-3 text-xs leading-6 text-zinc-500">{hint}</div> : null}
      </div>
    </div>
  )
}
