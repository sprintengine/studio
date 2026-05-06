import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import MemoryPreviewModal from '../memory/MemoryPreviewModal'

type PositionedNode = MemoryGraphNode & {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  color: string
}

type Camera = {
  x: number
  y: number
  scale: number
}

const GROUP_COLORS = [
  '#77d6ff',
  '#ffbf5f',
  '#a78bfa',
  '#7ee787',
  '#ff7ab6',
  '#f4d35e',
  '#6ee7d8',
  '#ff8f70',
  '#b8f7d4',
  '#d7b8ff',
]

function hashValue(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function colorForGroup(group: string): string {
  return GROUP_COLORS[hashValue(group) % GROUP_COLORS.length]
}

function nodeRadius(node: MemoryGraphNode): number {
  return Math.max(4, Math.min(18, 4 + Math.sqrt(node.degree) * 3))
}

function createPositionedNodes(nodes: MemoryGraphNode[], width: number, height: number): PositionedNode[] {
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.max(120, Math.min(width, height) * 0.34)

  return nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2
    const jitter = (hashValue(node.relativePath) % 100) / 100
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius * (0.45 + jitter * 0.65),
      y: centerY + Math.sin(angle) * radius * (0.45 + jitter * 0.65),
      vx: 0,
      vy: 0,
      radius: nodeRadius(node),
      color: node.kind === 'image' ? '#f4f7fb' : colorForGroup(node.group),
    }
  })
}

function buildNeighbors(edges: MemoryGraphEdge[]): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>()
  edges.forEach((edge) => {
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set())
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set())
    neighbors.get(edge.source)?.add(edge.target)
    neighbors.get(edge.target)?.add(edge.source)
  })
  return neighbors
}

function drawGraph(
  canvas: HTMLCanvasElement,
  nodes: PositionedNode[],
  edges: MemoryGraphEdge[],
  camera: Camera,
  hoveredId: string | null,
  selectedId: string | null,
  neighbors: Map<string, Set<string>>
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const ratio = window.devicePixelRatio || 1
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio)
    canvas.height = Math.floor(height * ratio)
  }

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#08090b'
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.globalAlpha = 0.55
  for (let i = 0; i < 120; i += 1) {
    const x = (hashValue(`x-${i}`) % Math.max(1, width))
    const y = (hashValue(`y-${i}`) % Math.max(1, height))
    const size = 0.45 + (hashValue(`s-${i}`) % 100) / 180
    ctx.fillStyle = i % 9 === 0 ? '#6ee7d8' : '#d7d7dc'
    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  ctx.save()
  ctx.translate(camera.x, camera.y)
  ctx.scale(camera.scale, camera.scale)

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const activeNeighborIds = hoveredId ? neighbors.get(hoveredId) ?? new Set<string>() : new Set<string>()

  edges.forEach((edge) => {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) return
    const active = hoveredId && (edge.source === hoveredId || edge.target === hoveredId)
    ctx.strokeStyle = active ? 'rgba(216, 255, 251, 0.74)' : 'rgba(150, 154, 170, 0.16)'
    ctx.lineWidth = active ? 1.3 / camera.scale : 0.75 / camera.scale
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
  })

  nodes.forEach((node) => {
    const active = node.id === hoveredId || node.id === selectedId || activeNeighborIds.has(node.id)
    const dimmed = Boolean(hoveredId && !active)
    const radius = node.radius * (node.id === selectedId ? 1.35 : node.id === hoveredId ? 1.25 : 1)

    ctx.globalAlpha = dimmed ? 0.34 : 1
    ctx.shadowColor = node.color
    ctx.shadowBlur = active ? 18 : node.degree > 0 ? 9 : 3
    ctx.fillStyle = node.color
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    if (node.kind === 'markdown') {
      ctx.strokeStyle = active ? '#ffffff' : 'rgba(255,255,255,0.42)'
      ctx.lineWidth = 1.2 / camera.scale
      ctx.stroke()
    } else if (node.kind === 'image') {
      ctx.fillStyle = 'rgba(8, 9, 11, 0.72)'
      ctx.fillRect(node.x - radius * 0.42, node.y - radius * 0.3, radius * 0.84, radius * 0.6)
    }
  })

  ctx.globalAlpha = 1
  const labelNodes = nodes
    .filter((node) => node.degree >= 2 || node.id === hoveredId || node.id === selectedId)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, hoveredId ? 18 : 28)

  ctx.font = `${11 / camera.scale}px Inter, Segoe UI, sans-serif`
  labelNodes.forEach((node) => {
    const active = node.id === hoveredId || node.id === selectedId
    ctx.fillStyle = active ? '#ececee' : 'rgba(215, 215, 220, 0.76)'
    ctx.fillText(node.name, node.x + node.radius + 5 / camera.scale, node.y + 4 / camera.scale)
  })

  ctx.restore()
}

function simulate(nodes: PositionedNode[], edges: MemoryGraphEdge[], width: number, height: number) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const centerX = width / 2
  const centerY = height / 2

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distanceSq = Math.max(60, dx * dx + dy * dy)
      const force = 900 / distanceSq
      const distance = Math.sqrt(distanceSq)
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
  }

  edges.forEach((edge) => {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) return
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const desired = 92 + Math.min(80, source.radius + target.radius)
    const force = (distance - desired) * 0.0024
    const fx = (dx / distance) * force
    const fy = (dy / distance) * force
    source.vx += fx
    source.vy += fy
    target.vx -= fx
    target.vy -= fy
  })

  nodes.forEach((node) => {
    node.vx += (centerX - node.x) * 0.0006
    node.vy += (centerY - node.y) * 0.0006
    node.vx *= 0.82
    node.vy *= 0.82
    node.x += Math.max(-8, Math.min(8, node.vx))
    node.y += Math.max(-8, Math.min(8, node.vy))
  })
}

export default function MemoryGraphPanel({ workspaceId }: { workspaceId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<PositionedNode[]>([])
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<{ x: number; y: number; camera: Camera } | null>(null)
  const [indexResult, setIndexResult] = useState<MemoryGraphIndexResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryPreviewResult | null>(null)
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.memoryIndex({
        workspaceRoot: workspace?.folderPath ?? null,
        relativeRoot: workspace?.memory.relativeRoot ?? null,
      })
      setIndexResult(result)
      setSelectedId(null)
      setHoveredId(null)
    } finally {
      setLoading(false)
    }
  }, [workspace?.folderPath, workspace?.memory.relativeRoot])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  const visibleData = useMemo(() => {
    if (!indexResult?.ok) return { nodes: [], edges: [] }
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return { nodes: indexResult.nodes, edges: indexResult.edges }
    const nodes = indexResult.nodes.filter((node) =>
      node.name.toLowerCase().includes(trimmed)
      || node.relativePath.toLowerCase().includes(trimmed)
      || node.group.toLowerCase().includes(trimmed)
    )
    const nodeIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: indexResult.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    }
  }, [indexResult, query])

  const neighbors = useMemo(() => buildNeighbors(visibleData.edges), [visibleData.edges])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = Math.max(600, canvas.clientWidth)
    const height = Math.max(420, canvas.clientHeight)
    nodesRef.current = createPositionedNodes(visibleData.nodes, width, height)
    cameraRef.current = { x: 0, y: 0, scale: 1 }
  }, [visibleData.nodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let frame = 0
    let disposed = false
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const tick = () => {
      if (disposed) return
      const width = Math.max(600, canvas.clientWidth)
      const height = Math.max(420, canvas.clientHeight)
      if (!reducedMotion) simulate(nodesRef.current, visibleData.edges, width, height)
      drawGraph(canvas, nodesRef.current, visibleData.edges, cameraRef.current, hoveredId, selectedId, neighbors)
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [hoveredId, neighbors, selectedId, visibleData.edges])

  const hitTest = (clientX: number, clientY: number): PositionedNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const camera = cameraRef.current
    const x = (clientX - rect.left - camera.x) / camera.scale
    const y = (clientY - rect.top - camera.y) / camera.scale
    let best: PositionedNode | null = null
    let bestDistance = Infinity
    nodesRef.current.forEach((node) => {
      const dx = x - node.x
      const dy = y - node.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance <= node.radius + 5 && distance < bestDistance) {
        best = node
        bestDistance = distance
      }
    })
    return best
  }

  const openPreview = async (node: MemoryGraphNode) => {
    setSelectedId(node.id)
    const result = await window.api.memoryReadPreview({
      workspaceRoot: workspace?.folderPath ?? null,
      relativeRoot: workspace?.memory.relativeRoot ?? null,
      relativePath: node.relativePath,
    })
    setPreview(result)
  }

  const topNodes = indexResult?.ok
    ? [...indexResult.nodes].sort((a, b) => b.degree - a.degree).slice(0, 6)
    : []

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08090b] text-[#d7d7dc]">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0d0e11] px-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8a8a92]">
            Memory Graph
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memory..."
            className="h-7 w-56 max-w-[40vw] rounded-md border border-[#24252b] bg-[#090a0c] px-2.5 text-[12px] text-[#ececee] outline-none placeholder:text-[#5a5a63] focus:border-[#4b4c55]"
          />
          <button
            type="button"
            onClick={() => void loadGraph()}
            className="h-7 rounded-md border border-[#24252b] bg-[#111216] px-2.5 text-[12px] font-semibold text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee]"
          >
            Refresh
          </button>
        </div>
      </div>

      {!workspace?.memory.relativeRoot ? (
        <MemoryNotice title="Memory is not configured" message="Set a workspace-relative memory path in Settings to render the graph." />
      ) : loading ? (
        <MemoryNotice title="Indexing memory" message="Reading local Markdown links and assets..." />
      ) : indexResult && !indexResult.ok ? (
        <MemoryNotice title="Memory folder unavailable" message={`${indexResult.message} Do not guess another folder.`} />
      ) : indexResult?.ok && visibleData.nodes.length === 0 ? (
        <MemoryNotice title="No memory files found" message="The configured memory folder is empty or the current filter has no matches." />
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="min-h-0 flex-1 cursor-grab active:cursor-grabbing"
            onMouseMove={(event) => {
              if (dragRef.current) {
                const dx = event.clientX - dragRef.current.x
                const dy = event.clientY - dragRef.current.y
                cameraRef.current = {
                  ...dragRef.current.camera,
                  x: dragRef.current.camera.x + dx,
                  y: dragRef.current.camera.y + dy,
                }
                return
              }
              setHoveredId(hitTest(event.clientX, event.clientY)?.id ?? null)
            }}
            onMouseLeave={() => {
              setHoveredId(null)
              dragRef.current = null
            }}
            onMouseDown={(event) => {
              dragRef.current = { x: event.clientX, y: event.clientY, camera: { ...cameraRef.current } }
            }}
            onMouseUp={(event) => {
              const wasDragging = dragRef.current
                ? Math.abs(event.clientX - dragRef.current.x) + Math.abs(event.clientY - dragRef.current.y) > 4
                : false
              dragRef.current = null
              if (wasDragging) return
              const node = hitTest(event.clientX, event.clientY)
              if (node) void openPreview(node)
            }}
            onWheel={(event) => {
              event.preventDefault()
              const nextScale = Math.max(0.35, Math.min(2.6, cameraRef.current.scale * (event.deltaY > 0 ? 0.92 : 1.08)))
              cameraRef.current = { ...cameraRef.current, scale: nextScale }
            }}
          />
          {indexResult?.ok ? (
            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[360px] rounded-md border border-[#24252b] bg-[#0d0e11]/88 px-3 py-2 text-[11px] text-[#9a9aa2] shadow-[0_16px_42px_rgba(0,0,0,0.35)]">
              <div className="mb-1 font-semibold text-[#d7d7dc]">
                {indexResult.nodes.length} files, {indexResult.edges.length} links
              </div>
              {topNodes.length > 0 ? (
                <div className="truncate">
                  Most connected: {topNodes.map((node) => node.name).join(', ')}
                </div>
              ) : null}
              {indexResult.unresolvedLinks.length > 0 ? (
                <div className="mt-1 text-[#ffd58a]">
                  {indexResult.unresolvedLinks.length} unresolved local link{indexResult.unresolvedLinks.length === 1 ? '' : 's'}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}

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

function MemoryNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <div className="text-sm font-semibold text-[#ececee]">{title}</div>
        <div className="mt-2 text-[13px] leading-6 text-[#7a7a83]">{message}</div>
      </div>
    </div>
  )
}
