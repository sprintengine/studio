import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'

export type Camera = { x: number; y: number; zoom: number }

export type MemoryGraphCanvasHandle = {
  zoomBy: (factor: number) => void
  resetView: () => void
  fitToView: () => void
  getCamera: () => Camera
}

export type ActivityPulse = {
  nodeId: string
  startedAt: number
}

export type ActivitySpark = {
  src: string
  dst: string
  startedAt: number
}

type Props = {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  /** Set of node ids that match the active search; null when no search is active. */
  matchIds: Set<string> | null
  onSelectNode: (node: MemoryGraphNode) => void
  onHoverNode: (node: MemoryGraphNode | null, screenPoint: { x: number; y: number } | null) => void
  onCameraChange?: (camera: Camera) => void
  /** Persistent traversal counts. Brightness scales with count. */
  synapses?: MemoryActivitySynapse[]
  /**
   * Latest activity event. The canvas creates a pulse on the active node and,
   * when prevNodeId is set, a spark travelling from prev to current. Bumping
   * `eventNonce` even with the same nodeId triggers a fresh pulse.
   */
  latestEvent?: MemoryActivityEvent | null
  eventNonce?: number
}

type PositionedNode = MemoryGraphNode & {
  x: number
  y: number
  vx: number
  vy: number
  /** When non-null, the node is pinned (during a drag). */
  fx: number | null
  fy: number | null
  radius: number
  color: string
  /** Cached lower-cased haystack for legend/colour grouping. */
  bucket: string
}

type Star = {
  x: number
  y: number
  radius: number
  baseAlpha: number
  amp: number
  period: number
  phase: number
}

// Palette comes from the spec; the legend reads the same map.
export const TYPE_COLORS: Record<string, string> = {
  concept: '#00e5ff',
  service: '#b388ff',
  flow: '#ffab40',
  debugging: '#ff5252',
  knowledge: '#69f0ae',
  product: '#ff6b9d',
  brand: '#feca57',
  decision: '#a3e635',
  reference: '#7dd3fc',
  default: '#94a3b8',
}

export function colorForNode(node: MemoryGraphNode): string {
  return TYPE_COLORS[bucketForNode(node)] ?? TYPE_COLORS.default
}

export function bucketForNode(node: MemoryGraphNode): string {
  const fromType = node.type?.trim().toLowerCase()
  if (fromType && TYPE_COLORS[fromType]) return fromType
  if (fromType) return fromType
  // No frontmatter type: fall back to the first folder, then a few filename heuristics
  // so a vault with everything at the root still gets multiple colours.
  const group = node.group?.toLowerCase() ?? ''
  if (group && group !== 'root' && TYPE_COLORS[group]) return group
  if (group && group !== 'root') return group
  const name = node.name.toLowerCase()
  if (/^multiauth/.test(name)) return 'service'
  if (/^multibench/.test(name)) return 'service'
  if (/^multibrand/.test(name)) return 'service'
  if (/^multivoice/.test(name)) return 'product'
  if (/^multicode/.test(name)) return 'product'
  if (/ecosystem|readme/.test(name)) return 'concept'
  if (/benchmark/.test(name)) return 'knowledge'
  return 'default'
}

const STARFIELD_COUNT = 600
const STARFIELD_HALF = 2400 // stars distributed uniformly over [-2400, 2400] in world coords
const PARALLAX = 0.45 // stars move at this fraction of the camera so they appear further

const REPULSION = 8000
const SPRING_REST = 170
const SPRING_K = 0.004
const CENTER_K = 0.0005
const DAMPING = 0.88
const MIN_ZOOM = 0.15
const MAX_ZOOM = 4

const PULSE_DURATION_MS = 600
const SPARK_DURATION_MS = 800
const SYNAPSE_COLOR = '#22d3ee'
const PULSE_COLOR = '#22d3ee'

const MemoryGraphCanvas = React.forwardRef<MemoryGraphCanvasHandle, Props>(function MemoryGraphCanvas(
  {
    nodes,
    edges,
    matchIds,
    onSelectNode,
    onHoverNode,
    onCameraChange,
    synapses,
    latestEvent,
    eventNonce,
  },
  forwardedRef
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positionedRef = useRef<PositionedNode[]>([])
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 })
  const starsRef = useRef<Star[]>([])
  const hoveredIdRef = useRef<string | null>(null)
  const matchIdsRef = useRef<Set<string> | null>(matchIds)
  matchIdsRef.current = matchIds

  const synapsesRef = useRef<MemoryActivitySynapse[]>(synapses ?? [])
  synapsesRef.current = synapses ?? []
  const pulsesRef = useRef<Map<string, ActivityPulse>>(new Map())
  const sparksRef = useRef<ActivitySpark[]>([])
  // The maximum count drives normalization for brightness; cache to avoid
  // recomputing it every frame.
  const synapseMaxRef = useRef<number>(1)

  const dragStateRef = useRef<
    | { kind: 'pan'; startX: number; startY: number; camera: Camera; moved: boolean }
    | { kind: 'node'; nodeId: string; offsetX: number; offsetY: number; moved: boolean }
    | null
  >(null)

  // Render-on-demand handles. The main effect installs these; everything that
  // mutates visual state (camera, drag, hover, pulses, sparks, search, resize)
  // calls requestRender(). bumpSimHot extends a window during which the physics
  // simulation runs each frame so a freshly-released node can settle.
  const requestRenderRef = useRef<(() => void) | null>(null)
  const bumpSimHotRef = useRef<((durationMs: number) => void) | null>(null)

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    edges.forEach((edge) => {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)!.add(edge.target)
      map.get(edge.target)!.add(edge.source)
    })
    return map
  }, [edges])

  // Recompute the synapse-count normalizer when the snapshot changes. A single
  // hot path with count = 50 should not wash out everything else, so we use
  // log normalization at draw time and cache the max here.
  useEffect(() => {
    let max = 1
    for (const s of synapsesRef.current) if (s.count > max) max = s.count
    synapseMaxRef.current = max
  }, [synapses])

  // A new event creates a pulse on the active node, and when the agent moved
  // from one file to another, an additional travelling spark. Same node twice
  // in a row only pulses (no spark), which matches the model.
  useEffect(() => {
    if (!latestEvent) return
    const now = performance.now()
    pulsesRef.current.set(latestEvent.nodeId, {
      nodeId: latestEvent.nodeId,
      startedAt: now,
    })
    if (latestEvent.prevNodeId && latestEvent.prevNodeId !== latestEvent.nodeId) {
      sparksRef.current.push({
        src: latestEvent.prevNodeId,
        dst: latestEvent.nodeId,
        startedAt: now,
      })
    }
    requestRenderRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestEvent, eventNonce])

  // Search match changes don't trigger any other render path, so wake the
  // canvas explicitly when matchIds toggles or the matched set shifts.
  useEffect(() => {
    requestRenderRef.current?.()
  }, [matchIds])

  // Generate the starfield once. Stars live in a large world-space patch so
  // panning and zooming reveals new constellations.
  if (starsRef.current.length === 0) {
    const stars: Star[] = []
    let seed = 0xc0ffee
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < STARFIELD_COUNT; i += 1) {
      stars.push({
        x: (rand() * 2 - 1) * STARFIELD_HALF,
        y: (rand() * 2 - 1) * STARFIELD_HALF,
        radius: 0.4 + rand() * 1.2,
        baseAlpha: 0.25 + rand() * 0.5,
        amp: 0.15 + rand() * 0.35,
        period: 1800 + rand() * 4200,
        phase: rand() * Math.PI * 2,
      })
    }
    starsRef.current = stars
  }

  // Rebuild the positioned-node list when the visible set changes. We preserve
  // any prior position/velocity so a node that survives a re-render keeps its
  // place in the layout instead of jumping back to a circle.
  useEffect(() => {
    const previous = new Map(positionedRef.current.map((n) => [n.id, n] as const))
    // Total degree (in + out) reads as visual importance better than inbound
    // alone — a vault with many shallow leaves looks too uniform otherwise.
    // Sqrt curve so mid-rank nodes stay distinct from leaves.
    const maxDegree = Math.max(1, ...nodes.map((n) => n.degree || 0))
    const hasPriorLayout = positionedRef.current.length > 0
    const positioned: PositionedNode[] = nodes.map((node, index) => {
      const prior = previous.get(node.id)
      const radius = 5 + Math.sqrt((node.degree || 0) / maxDegree) * 24
      const color = colorForNode(node)
      const bucket = bucketForNode(node)
      if (prior) {
        return {
          ...node,
          x: prior.x,
          y: prior.y,
          vx: prior.vx,
          vy: prior.vy,
          fx: prior.fx,
          fy: prior.fy,
          radius,
          color,
          bucket,
        }
      }
      // Fresh node: drop on a wide ring so the simulation has room to spread.
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2
      const ring = 220 + (index % 3) * 60
      return {
        ...node,
        x: Math.cos(angle) * ring,
        y: Math.sin(angle) * ring,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        radius,
        color,
        bucket,
      }
    })
    positionedRef.current = positioned

    // Pre-warm the simulation when the layout is fresh so the first paint shows
    // a settled graph instead of nodes still spreading across the viewport.
    // Skip on incremental updates where most positions carried over.
    if (!hasPriorLayout && positioned.length > 0) {
      for (let i = 0; i < 280; i += 1) {
        stepSimulation(positioned, edges)
      }
      // Frame the settled graph immediately so the user never sees the
      // zoomed-in tight-ring intermediate state.
      const canvas = canvasRef.current
      if (canvas) {
        const w = canvas.clientWidth
        const h = canvas.clientHeight
        if (w > 0 && h > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const node of positioned) {
            if (node.x - node.radius < minX) minX = node.x - node.radius
            if (node.y - node.radius < minY) minY = node.y - node.radius
            if (node.x + node.radius > maxX) maxX = node.x + node.radius
            if (node.y + node.radius > maxY) maxY = node.y + node.radius
          }
          const dx = Math.max(1, maxX - minX)
          const dy = Math.max(1, maxY - minY)
          const padding = 80
          const zoom = clamp(
            Math.min((w - padding * 2) / dx, (h - padding * 2) / dy),
            MIN_ZOOM,
            MAX_ZOOM
          )
          const cx = (minX + maxX) / 2
          const cy = (minY + maxY) / 2
          cameraRef.current = { zoom, x: -cx * zoom, y: -cy * zoom }
          onCameraChange?.(cameraRef.current)
        }
      }
    }
    // The set of visible nodes changed; ask the canvas to redraw. New nodes
    // also get a brief sim-hot window so they ease into place rather than
    // popping in.
    bumpSimHotRef.current?.(400)
    requestRenderRef.current?.()
  }, [nodes, edges, onCameraChange])

  // Render-on-demand loop. We only schedule a frame when something visual has
  // changed (camera, drag, hover, search, resize) or while an animation is
  // still alive (drag, sim-hot window, pulses, sparks). Idle = zero work.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let frame: number | null = null
    let disposed = false
    let simHotUntil = 0

    const requestRender = () => {
      if (disposed) return
      if (frame !== null) return
      frame = requestAnimationFrame(step)
    }

    const bumpSimHot = (durationMs: number) => {
      const target = performance.now() + durationMs
      if (target > simHotUntil) simHotUntil = target
      requestRender()
    }

    const step = () => {
      frame = null
      if (disposed) return
      const positioned = positionedRef.current
      const camera = cameraRef.current
      const matchSet = matchIdsRef.current
      const hoveredId = hoveredIdRef.current

      const drag = dragStateRef.current
      const isDraggingNode = drag?.kind === 'node'
      const inRelaxWindow = performance.now() < simHotUntil
      const simShouldRun = isDraggingNode || inRelaxWindow

      if (simShouldRun) {
        stepSimulation(positioned, edges)
      }
      const pos = positioned
      const byId = new Map(pos.map((n) => [n.id, n] as const))

      // Resize backing store to match CSS size.
      const ratio = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const targetW = Math.floor(width * ratio)
      const targetH = Math.floor(height * ratio)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.fillStyle = '#0a0a1a'
      ctx.fillRect(0, 0, width, height)

      // Starfield in a pseudo-camera scaled down so stars parallax behind the
      // graph. Twinkle by per-star sine phase.
      const now = performance.now()
      ctx.save()
      ctx.translate(width / 2 + camera.x * PARALLAX, height / 2 + camera.y * PARALLAX)
      ctx.scale(camera.zoom * PARALLAX, camera.zoom * PARALLAX)
      for (const star of starsRef.current) {
        const t = (now / star.period) * Math.PI * 2 + star.phase
        const alpha = clamp01(star.baseAlpha + Math.sin(t) * star.amp)
        if (alpha <= 0.02) continue
        ctx.globalAlpha = alpha
        ctx.fillStyle = '#e0e0e0'
        ctx.beginPath()
        ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.restore()

      // Main world transform.
      ctx.save()
      ctx.translate(width / 2 + camera.x, height / 2 + camera.y)
      ctx.scale(camera.zoom, camera.zoom)

      const focusNeighbors = hoveredId ? neighbors.get(hoveredId) ?? null : null
      const isMatched = (id: string): boolean => (matchSet ? matchSet.has(id) : true)

      // Edges first so nodes draw on top.
      ctx.lineCap = 'round'
      const baseLine = 1 / camera.zoom
      for (const edge of edges) {
        const a = byId.get(edge.source)
        const b = byId.get(edge.target)
        if (!a || !b) continue
        const touchesHover = hoveredId
          ? edge.source === hoveredId || edge.target === hoveredId
          : false
        const bothMatched = isMatched(a.id) && isMatched(b.id)
        const dimmed = matchSet && !bothMatched

        ctx.strokeStyle = touchesHover
          ? 'rgba(96, 165, 250, 0.62)'
          : dimmed
            ? 'rgba(255, 255, 255, 0.025)'
            : 'rgba(255, 255, 255, 0.07)'
        ctx.lineWidth = touchesHover ? baseLine * 1.35 : baseLine * 0.85
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Synapse layer — persistent traversal counts. Brightness scales with
      // log(count) so a single hot path doesn't wash everything else out.
      const synapseList = synapsesRef.current
      if (synapseList.length > 0) {
        const maxCount = Math.max(1, synapseMaxRef.current)
        const logMax = Math.log(maxCount + 1)
        for (const s of synapseList) {
          const a = byId.get(s.src)
          const b = byId.get(s.dst)
          if (!a || !b) continue
          const norm = logMax > 0 ? Math.log(s.count + 1) / logMax : 0
          const alpha = 0.1 + 0.3 * norm
          ctx.strokeStyle = hexWithAlpha(SYNAPSE_COLOR, alpha)
          ctx.lineWidth = baseLine * (0.9 + 1.05 * norm)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      // Halos behind nodes.
      for (const node of pos) {
        const matched = isMatched(node.id)
        const dimmed = !matched
        const isHover = node.id === hoveredId
        const isNeighbor = focusNeighbors?.has(node.id) ?? false
        const focused = isHover || isNeighbor || hoveredId === null
        if (dimmed) continue
        const haloRadius = node.radius * (isHover ? 3.3 : 2.25)
        const grad = ctx.createRadialGradient(node.x, node.y, node.radius * 0.4, node.x, node.y, haloRadius)
        const alpha = isHover ? 0.34 : focused ? 0.13 : 0.07
        grad.addColorStop(0, hexWithAlpha(node.color, alpha))
        grad.addColorStop(1, hexWithAlpha(node.color, 0))
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(node.x, node.y, haloRadius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Solid node circles.
      for (const node of pos) {
        const matched = isMatched(node.id)
        const isHover = node.id === hoveredId
        const isNeighbor = focusNeighbors?.has(node.id) ?? false
        const dimAlpha = !matched ? 0.18 : hoveredId && !isHover && !isNeighbor ? 0.55 : 1
        ctx.globalAlpha = dimAlpha
        ctx.fillStyle = node.color
        const r = node.radius * (isHover ? 1.18 : 1)
        ctx.beginPath()
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
        ctx.fill()
        if (isHover) {
          ctx.lineWidth = 1.5 / camera.zoom
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'
          ctx.stroke()
        } else if (node.fx !== null) {
          ctx.lineWidth = 1 / camera.zoom
          ctx.strokeStyle = 'rgba(255,255,255,0.45)'
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1

      // Pulse layer — expanding ring on the just-fired node, decays over
      // PULSE_DURATION_MS. The map is keyed by nodeId so a re-fire on the
      // same node simply restarts the animation.
      if (pulsesRef.current.size > 0) {
        for (const [id, pulse] of pulsesRef.current) {
          const elapsed = now - pulse.startedAt
          const t = elapsed / PULSE_DURATION_MS
          if (t >= 1) {
            pulsesRef.current.delete(id)
            continue
          }
          const node = byId.get(id)
          if (!node) continue
          const eased = 1 - Math.pow(1 - t, 2)
          const ringRadius = node.radius * (1 + eased * 5)
          const alpha = (1 - t) * 0.85
          ctx.lineWidth = (2 + (1 - t) * 3) / camera.zoom
          ctx.strokeStyle = hexWithAlpha(PULSE_COLOR, alpha)
          ctx.beginPath()
          ctx.arc(node.x, node.y, ringRadius, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      // Spark layer — bright dot travelling from prev to current node,
      // representing the agent's attention crossing a synapse.
      if (sparksRef.current.length > 0) {
        const remaining: ActivitySpark[] = []
        for (const spark of sparksRef.current) {
          const elapsed = now - spark.startedAt
          const t = elapsed / SPARK_DURATION_MS
          if (t >= 1) continue
          const a = byId.get(spark.src)
          const b = byId.get(spark.dst)
          if (!a || !b) {
            remaining.push(spark)
            continue
          }
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const x = a.x + (b.x - a.x) * eased
          const y = a.y + (b.y - a.y) * eased
          const dotR = 4 / camera.zoom
          // Trailing comet tail toward the source.
          const tailX = a.x + (b.x - a.x) * Math.max(0, eased - 0.12)
          const tailY = a.y + (b.y - a.y) * Math.max(0, eased - 0.12)
          ctx.lineWidth = (3 / camera.zoom)
          ctx.strokeStyle = hexWithAlpha(PULSE_COLOR, 0.55 * (1 - t))
          ctx.beginPath()
          ctx.moveTo(tailX, tailY)
          ctx.lineTo(x, y)
          ctx.stroke()
          ctx.fillStyle = hexWithAlpha(PULSE_COLOR, 0.95)
          ctx.beginPath()
          ctx.arc(x, y, dotR, 0, Math.PI * 2)
          ctx.fill()
          remaining.push(spark)
        }
        sparksRef.current = remaining
      }

      // Labels — at low zoom, only the top hubs by degree get a label so the
      // graph stays readable; hover, neighbors, and search matches are always
      // shown regardless of rank.
      const labelEligibleIds = (() => {
        if (hoveredId) {
          const set = new Set<string>([hoveredId])
          focusNeighbors?.forEach((id) => set.add(id))
          return set
        }
        if (matchSet) return new Set(matchSet)
        // visibleCount scales linearly with zoom: ~3 at min zoom (0.15),
        // ~25 at zoom 1, every node by ~zoom 1.6.
        const visibleCount = Math.max(3, Math.min(pos.length, Math.round(camera.zoom * 25)))
        const ranked = [...pos]
          .sort((a, b) => (b.degree || 0) - (a.degree || 0))
          .slice(0, visibleCount)
        return new Set(ranked.map((n) => n.id))
      })()

      const labelPx = 12 / camera.zoom
      ctx.font = `${labelPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const node of pos) {
        if (!labelEligibleIds.has(node.id)) continue
        const isHover = node.id === hoveredId
        const isNeighbor = focusNeighbors?.has(node.id) ?? false
        const focused = isHover || isNeighbor
        const alpha = isHover ? 1 : focused ? 0.95 : matchSet ? 1 : 0.78
        ctx.globalAlpha = alpha
        ctx.fillStyle = isHover ? '#ffffff' : '#e0e0e0'
        const label = node.title?.trim() || node.name
        ctx.fillText(label, node.x, node.y + node.radius + 4 / camera.zoom)
      }
      ctx.globalAlpha = 1
      ctx.restore()

      // Reschedule only while something is still animating. Otherwise the
      // canvas sleeps until an event wakes it via requestRender().
      const stillAnimating =
        isDraggingNode ||
        performance.now() < simHotUntil ||
        pulsesRef.current.size > 0 ||
        sparksRef.current.length > 0
      if (stillAnimating) {
        requestRender()
      }
    }

    requestRenderRef.current = requestRender
    bumpSimHotRef.current = bumpSimHot

    // Canvas resizes (window, splitter, devtools) need a redraw — the backing
    // store size is read inside step().
    const resizeObserver = new ResizeObserver(() => requestRender())
    resizeObserver.observe(canvas)

    requestRender()
    return () => {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      if (requestRenderRef.current === requestRender) requestRenderRef.current = null
      if (bumpSimHotRef.current === bumpSimHot) bumpSimHotRef.current = null
    }
  }, [edges, neighbors])

  // Imperative camera handles.
  useImperativeHandle(forwardedRef, () => ({
    zoomBy: (factor) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const next = clamp(cameraRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      cameraRef.current = { ...cameraRef.current, zoom: next }
      onCameraChange?.(cameraRef.current)
      requestRenderRef.current?.()
    },
    resetView: () => {
      cameraRef.current = { x: 0, y: 0, zoom: 1 }
      onCameraChange?.(cameraRef.current)
      requestRenderRef.current?.()
    },
    fitToView: () => {
      const canvas = canvasRef.current
      const positioned = positionedRef.current
      if (!canvas || positioned.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const node of positioned) {
        if (node.x - node.radius < minX) minX = node.x - node.radius
        if (node.y - node.radius < minY) minY = node.y - node.radius
        if (node.x + node.radius > maxX) maxX = node.x + node.radius
        if (node.y + node.radius > maxY) maxY = node.y + node.radius
      }
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dx = Math.max(1, maxX - minX)
      const dy = Math.max(1, maxY - minY)
      const padding = 80
      const zoom = clamp(Math.min((w - padding * 2) / dx, (h - padding * 2) / dy), MIN_ZOOM, MAX_ZOOM)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      cameraRef.current = { zoom, x: -cx * zoom, y: -cy * zoom }
      onCameraChange?.(cameraRef.current)
      requestRenderRef.current?.()
    },
    getCamera: () => ({ ...cameraRef.current }),
  }))

  // Wheel zoom — zoom toward the cursor, clamped to spec range. Listener is
  // non-passive so we can preventDefault on trackpads.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY === 0) return
      const camera = cameraRef.current
      const rect = canvas.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      // Convert mouse position to world coords relative to the centred origin.
      const wx = (mx - rect.width / 2 - camera.x) / camera.zoom
      const wy = (my - rect.height / 2 - camera.y) / camera.zoom
      const normalised = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      const factor = Math.exp(-clamp(normalised, -120, 120) * 0.0035)
      const nextZoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      if (nextZoom === camera.zoom) return
      cameraRef.current = {
        zoom: nextZoom,
        x: mx - rect.width / 2 - wx * nextZoom,
        y: my - rect.height / 2 - wy * nextZoom,
      }
      onCameraChange?.(cameraRef.current)
      requestRenderRef.current?.()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onCameraChange])

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const camera = cameraRef.current
    const mx = clientX - rect.left
    const my = clientY - rect.top
    return {
      x: (mx - rect.width / 2 - camera.x) / camera.zoom,
      y: (my - rect.height / 2 - camera.y) / camera.zoom,
    }
  }, [])

  const hitTest = useCallback((clientX: number, clientY: number): PositionedNode | null => {
    const { x, y } = screenToWorld(clientX, clientY)
    let best: PositionedNode | null = null
    let bestDist = Infinity
    for (const node of positionedRef.current) {
      const dx = x - node.x
      const dy = y - node.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= node.radius + 6 && dist < bestDist) {
        best = node
        bestDist = dist
      }
    }
    return best
  }, [screenToWorld])

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full cursor-grab select-none active:cursor-grabbing"
      onMouseDown={(event) => {
        const target = hitTest(event.clientX, event.clientY)
        if (target) {
          const live = positionedRef.current.find((n) => n.id === target.id)
          if (!live) return
          live.fx = live.x
          live.fy = live.y
          const world = screenToWorld(event.clientX, event.clientY)
          dragStateRef.current = {
            kind: 'node',
            nodeId: target.id,
            offsetX: world.x - target.x,
            offsetY: world.y - target.y,
            moved: false,
          }
        } else {
          dragStateRef.current = {
            kind: 'pan',
            startX: event.clientX,
            startY: event.clientY,
            camera: { ...cameraRef.current },
            moved: false,
          }
        }
        requestRenderRef.current?.()
      }}
      onMouseMove={(event) => {
        const drag = dragStateRef.current
        if (drag?.kind === 'pan') {
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
          cameraRef.current = {
            zoom: drag.camera.zoom,
            x: drag.camera.x + dx,
            y: drag.camera.y + dy,
          }
          onCameraChange?.(cameraRef.current)
          requestRenderRef.current?.()
          return
        }
        if (drag?.kind === 'node') {
          const world = screenToWorld(event.clientX, event.clientY)
          const live = positionedRef.current.find((n) => n.id === drag.nodeId)
          if (live) {
            live.fx = world.x - drag.offsetX
            live.fy = world.y - drag.offsetY
            live.x = live.fx
            live.y = live.fy
          }
          drag.moved = true
          requestRenderRef.current?.()
          return
        }
        const node = hitTest(event.clientX, event.clientY)
        const id = node?.id ?? null
        const hoverChanged = id !== hoveredIdRef.current
        if (hoverChanged) {
          hoveredIdRef.current = id
        }
        const rect = canvasRef.current?.getBoundingClientRect()
        const point = rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null
        onHoverNode(node, node ? point : null)
        if (hoverChanged) requestRenderRef.current?.()
      }}
      onMouseLeave={() => {
        const had = hoveredIdRef.current !== null
        hoveredIdRef.current = null
        onHoverNode(null, null)
        if (had) requestRenderRef.current?.()
      }}
      onMouseUp={(event) => {
        const drag = dragStateRef.current
        dragStateRef.current = null
        if (!drag) return
        // Release the pin so the simulation reclaims the node naturally; user
        // can still re-grab it by starting a new drag.
        if (drag.kind === 'node') {
          const live = positionedRef.current.find((n) => n.id === drag.nodeId)
          if (live) {
            live.fx = null
            live.fy = null
          }
          // Let the released node and its neighbours relax for a beat before
          // the canvas freezes again.
          bumpSimHotRef.current?.(800)
        }
        if (drag.moved) {
          requestRenderRef.current?.()
          return
        }
        const node = hitTest(event.clientX, event.clientY)
        if (node) onSelectNode(node)
        requestRenderRef.current?.()
      }}
    />
  )
})

export default MemoryGraphCanvas

/**
 * One physics tick: O(N²) repulsion, O(N) gravity, O(E) spring, then integrate.
 * Pinned nodes (fx/fy non-null) are clamped to their pin every step so a drag
 * stays sticky. Same routine drives both the pre-warm pass at load and every
 * subsequent rAF frame.
 */
function stepSimulation(pos: PositionedNode[], edges: MemoryGraphEdge[]) {
  for (let i = 0; i < pos.length; i += 1) {
    const a = pos[i]
    if (a.fx !== null && a.fy !== null) continue
    let ax = 0
    let ay = 0
    for (let j = 0; j < pos.length; j += 1) {
      if (i === j) continue
      const b = pos[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distSq = Math.max(0.01, dx * dx + dy * dy)
      const force = REPULSION / distSq
      const dist = Math.sqrt(distSq)
      ax += (dx / dist) * force
      ay += (dy / dist) * force
    }
    ax += -a.x * CENTER_K
    ay += -a.y * CENTER_K
    a.vx = (a.vx + ax) * DAMPING
    a.vy = (a.vy + ay) * DAMPING
  }

  const byId = new Map(pos.map((n) => [n.id, n] as const))
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy))
    const force = (dist - SPRING_REST) * SPRING_K
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (a.fx === null) {
      a.vx += fx
      a.vy += fy
    }
    if (b.fx === null) {
      b.vx -= fx
      b.vy -= fy
    }
  }

  for (const node of pos) {
    if (node.fx !== null && node.fy !== null) {
      node.x = node.fx
      node.y = node.fy
      node.vx = 0
      node.vy = 0
      continue
    }
    node.x += node.vx
    node.y += node.vy
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** Convert `#rrggbb` to `rgba(r, g, b, a)`; passes through any other format unchanged. */
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
