import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { MemoryGraphDisplayConfig, MemoryGraphForcesConfig } from '../../types/workspace'
import {
  Camera,
  PositionedNode,
  UNRESOLVED_COLOR,
  colorForRelativePath,
} from './memoryGraphTypes'
import { useMemoryGraphSimulation } from './useMemoryGraphSimulation'
import type { MemoryGraphColorRule } from '../../types/workspace'

export type MemoryGraphCanvasHandle = {
  zoomBy: (factor: number) => void
  resetView: () => void
  fitToView: () => void
  getCamera: () => Camera
}

type Props = {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  unresolvedNodes: MemoryGraphNode[]
  display: MemoryGraphDisplayConfig
  forces: MemoryGraphForcesConfig
  colorRules: MemoryGraphColorRule[]
  hoveredId: string | null
  selectedId: string | null
  onHoverNode: (node: MemoryGraphNode | null) => void
  onSelectNode: (node: MemoryGraphNode) => void
  onCameraChange?: (camera: Camera) => void
}

const PADDING = 60

function nodeRadius(node: MemoryGraphNode, scale: number): number {
  return Math.max(5, Math.min(24, 5 + Math.sqrt(Math.max(0, node.degree)) * 3)) * scale
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

function hashSeed(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function placeOnCircle(node: MemoryGraphNode, index: number, total: number, width: number, height: number): { x: number; y: number } {
  const cx = width / 2
  const cy = height / 2
  const radius = Math.max(140, Math.min(width, height) * 0.34)
  const angle = (index / Math.max(1, total)) * Math.PI * 2 + (hashSeed(node.id) % 100) / 100
  const jitter = 0.55 + (hashSeed(node.relativePath) % 100) / 220
  return { x: cx + Math.cos(angle) * radius * jitter, y: cy + Math.sin(angle) * radius * jitter }
}

const MemoryGraphCanvas = React.forwardRef<MemoryGraphCanvasHandle, Props>(function MemoryGraphCanvas(
  {
    nodes,
    edges,
    unresolvedNodes,
    display,
    forces,
    colorRules,
    hoveredId,
    selectedId,
    onHoverNode,
    onSelectNode,
    onCameraChange,
  },
  forwardedRef
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 })
  const positionedRef = useRef<PositionedNode[]>([])
  const ghostsRef = useRef<PositionedNode[]>([])
  const starsRef = useRef<Star[]>([])
  const starfieldDimsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const dragStateRef = useRef<
    | { kind: 'pan'; startX: number; startY: number; camera: Camera; moved: boolean }
    | { kind: 'node'; nodeId: string; offsetX: number; offsetY: number; moved: boolean }
    | null
  >(null)
  const hoverIdRef = useRef<string | null>(hoveredId)
  const selectedIdRef = useRef<string | null>(selectedId)
  hoverIdRef.current = hoveredId
  selectedIdRef.current = selectedId

  const neighbors = useMemo(() => buildNeighbors(edges), [edges])

  // Rebuild positioned nodes when the visible node set changes.
  useEffect(() => {
    const canvas = canvasRef.current
    const width = canvas?.clientWidth ?? 800
    const height = canvas?.clientHeight ?? 600

    const previous = new Map(positionedRef.current.map((node) => [node.id, node] as const))
    const positioned: PositionedNode[] = nodes.map((node, index) => {
      const prior = previous.get(node.id)
      if (prior) {
        return {
          ...node,
          x: prior.x,
          y: prior.y,
          vx: prior.vx,
          vy: prior.vy,
          fx: prior.fx,
          fy: prior.fy,
          radius: nodeRadius(node, display.nodeSizeScale),
          color: colorForRelativePath(node.relativePath, node.group, colorRules),
          visible: true,
        }
      }
      const placed = placeOnCircle(node, index, nodes.length, width, height)
      return {
        ...node,
        x: placed.x,
        y: placed.y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        radius: nodeRadius(node, display.nodeSizeScale),
        color: colorForRelativePath(node.relativePath, node.group, colorRules),
        visible: true,
      }
    })
    positionedRef.current = positioned

    const ghosts: PositionedNode[] = unresolvedNodes.map((node, index) => {
      const placed = placeOnCircle(node, index, Math.max(1, unresolvedNodes.length), width, height)
      return {
        ...node,
        x: placed.x,
        y: placed.y,
        vx: 0,
        vy: 0,
        fx: placed.x,
        fy: placed.y,
        radius: nodeRadius(node, display.nodeSizeScale * 0.85),
        color: UNRESOLVED_COLOR,
        visible: true,
      }
    })
    ghostsRef.current = ghosts
  }, [nodes, unresolvedNodes, display.nodeSizeScale, colorRules])

  // Refresh radius and color when display/colors change without resetting positions.
  useEffect(() => {
    positionedRef.current = positionedRef.current.map((node) => ({
      ...node,
      radius: nodeRadius(node, display.nodeSizeScale),
      color: colorForRelativePath(node.relativePath, node.group, colorRules),
    }))
    ghostsRef.current = ghostsRef.current.map((node) => ({
      ...node,
      radius: nodeRadius(node, display.nodeSizeScale * 0.85),
    }))
  }, [display.nodeSizeScale, colorRules])

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

  const sim = useMemoryGraphSimulation(positionedRef, nodes, edges, {
    forces,
    width: canvasRef.current?.clientWidth ?? 800,
    height: canvasRef.current?.clientHeight ?? 600,
    reducedMotion,
  })

  // Bump alpha when forces or topology change.
  useEffect(() => {
    sim.bump(0.6)
  }, [forces.centerForce, forces.repelForce, forces.linkForce, forces.linkDistance, edges.length, sim])

  // Draw loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let frame = 0
    let disposed = false
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      if (disposed) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const ratio = window.devicePixelRatio || 1
      const targetW = Math.floor(width * ratio)
      const targetH = Math.floor(height * ratio)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#09090b'
      ctx.fillRect(0, 0, width, height)

      if (display.starfield) {
        if (
          starsRef.current.length === 0
          || starfieldDimsRef.current.width !== width
          || starfieldDimsRef.current.height !== height
        ) {
          starsRef.current = generateStars(width, height)
          starfieldDimsRef.current = { width, height }
        }
        drawStarfield(ctx, starsRef.current, performance.now())
      }

      const camera = cameraRef.current
      ctx.save()
      ctx.translate(camera.x, camera.y)
      ctx.scale(camera.scale, camera.scale)

      const positioned = positionedRef.current
      const ghosts = ghostsRef.current
      const nodeById = new Map(positioned.map((n) => [n.id, n]))
      const ghostById = new Map(ghosts.map((n) => [n.id, n]))
      const hovered = hoverIdRef.current
      const selected = selectedIdRef.current
      const focusId = hovered ?? selected
      const focusNeighbors = focusId ? neighbors.get(focusId) ?? new Set<string>() : null

      // Edges
      ctx.lineCap = 'round'
      const baseLineWidth = (1 / camera.scale) * display.lineThicknessScale
      edges.forEach((edge) => {
        const source = nodeById.get(edge.source) ?? ghostById.get(edge.source)
        const target = nodeById.get(edge.target) ?? ghostById.get(edge.target)
        if (!source || !target) return
        const isActive = focusId
          ? edge.source === focusId || edge.target === focusId
          : false
        const dimmed = focusId && !isActive

        ctx.strokeStyle = isActive
          ? 'rgba(199, 210, 254, 0.95)'
          : dimmed
            ? 'rgba(113, 113, 122, 0.22)'
            : 'rgba(161, 161, 170, 0.62)'
        ctx.lineWidth = isActive ? baseLineWidth * 1.8 : baseLineWidth * 1.15

        const ghostEdge = target.color === UNRESOLVED_COLOR || source.color === UNRESOLVED_COLOR
        ctx.setLineDash(ghostEdge ? [3 / camera.scale, 3 / camera.scale] : [])

        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        if (display.curvedEdges) {
          const dx = target.x - source.x
          const dy = target.y - source.y
          const mx = (source.x + target.x) / 2
          const my = (source.y + target.y) / 2
          const ox = -dy * 0.18
          const oy = dx * 0.18
          ctx.quadraticCurveTo(mx + ox, my + oy, target.x, target.y)
        } else {
          ctx.lineTo(target.x, target.y)
        }
        ctx.stroke()

        if (display.showArrows && !dimmed) {
          drawArrowHead(ctx, source, target, baseLineWidth * 3, isActive)
        }
      })
      ctx.setLineDash([])

      // Ghost (unresolved) nodes
      ghosts.forEach((node) => {
        ctx.globalAlpha = focusId && !focusNeighbors?.has(node.id) ? 0.35 : 0.7
        ctx.strokeStyle = '#52525b'
        ctx.fillStyle = 'rgba(9, 9, 11, 0.0)'
        ctx.lineWidth = (1 / camera.scale) * display.lineThicknessScale
        ctx.setLineDash([2 / camera.scale, 2 / camera.scale])
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      })
      ctx.globalAlpha = 1

      // Halos behind active nodes
      if (display.glowHalos && focusId) {
        const focus = nodeById.get(focusId) ?? ghostById.get(focusId)
        if (focus) {
          const grad = ctx.createRadialGradient(
            focus.x,
            focus.y,
            focus.radius * 0.6,
            focus.x,
            focus.y,
            focus.radius * 5
          )
          grad.addColorStop(0, 'rgba(129, 140, 248, 0.55)')
          grad.addColorStop(1, 'rgba(129, 140, 248, 0)')
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(focus.x, focus.y, focus.radius * 5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Nodes
      positioned.forEach((node) => {
        const isHovered = node.id === hovered
        const isSelected = node.id === selected
        const isNeighbor = focusNeighbors?.has(node.id) ?? false
        const isActive = isHovered || isSelected || isNeighbor || node.id === focusId
        const dimmed = focusId && !isActive

        ctx.globalAlpha = dimmed ? 0.32 : 1
        const radius = node.radius * (isSelected ? 1.35 : isHovered ? 1.2 : 1)

        ctx.fillStyle = node.color
        ctx.beginPath()
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
        ctx.fill()

        if (isHovered || isSelected) {
          ctx.lineWidth = 1.5 / camera.scale
          ctx.strokeStyle = isSelected ? '#f4f4f5' : 'rgba(244, 244, 245, 0.85)'
          ctx.stroke()
        } else if (node.fx !== null && node.fy !== null) {
          ctx.lineWidth = 1 / camera.scale
          ctx.strokeStyle = 'rgba(244, 244, 245, 0.5)'
          ctx.stroke()
        }
      })
      ctx.globalAlpha = 1

      // Labels — fade based on zoom + node prominence
      const labelFontPx = display.labelFontSize / camera.scale
      ctx.font = `${labelFontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
      ctx.textBaseline = 'middle'

      const fadeIn = display.labelFadeThreshold
      const labelOpacityForZoom = clamp01((camera.scale - fadeIn * 0.6) / Math.max(0.001, fadeIn))

      const focusedNode = focusId
        ? nodeById.get(focusId) ?? ghostById.get(focusId) ?? null
        : null
      const visibleLabels = pickLabelNodes(positioned, focusedNode, focusNeighbors, labelOpacityForZoom)

      visibleLabels.forEach(({ node, alpha }) => {
        ctx.globalAlpha = alpha
        ctx.fillStyle = node.id === focusId ? '#f4f4f5' : 'rgba(228, 228, 231, 0.9)'
        ctx.fillText(node.name, node.x + node.radius + 6 / camera.scale, node.y)
      })
      ctx.globalAlpha = 1

      ctx.restore()

      frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [edges, neighbors, display.curvedEdges, display.glowHalos, display.labelFadeThreshold, display.labelFontSize, display.lineThicknessScale, display.showArrows, display.starfield])

  // Imperative camera handles for the zoom HUD.
  useImperativeHandle(forwardedRef, () => ({
    zoomBy: (factor) => {
      const next = clamp(cameraRef.current.scale * factor, 0.25, 3)
      const canvas = canvasRef.current
      if (canvas) {
        const cx = canvas.clientWidth / 2
        const cy = canvas.clientHeight / 2
        const old = cameraRef.current
        const wx = (cx - old.x) / old.scale
        const wy = (cy - old.y) / old.scale
        cameraRef.current = {
          scale: next,
          x: cx - wx * next,
          y: cy - wy * next,
        }
        onCameraChange?.(cameraRef.current)
      }
    },
    resetView: () => {
      cameraRef.current = { x: 0, y: 0, scale: 1 }
      onCameraChange?.(cameraRef.current)
    },
    fitToView: () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const positioned = positionedRef.current
      if (positioned.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      positioned.forEach((node) => {
        if (node.x - node.radius < minX) minX = node.x - node.radius
        if (node.y - node.radius < minY) minY = node.y - node.radius
        if (node.x + node.radius > maxX) maxX = node.x + node.radius
        if (node.y + node.radius > maxY) maxY = node.y + node.radius
      })
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dx = maxX - minX
      const dy = maxY - minY
      if (dx <= 0 || dy <= 0) return
      const scale = clamp(Math.min((w - PADDING * 2) / dx, (h - PADDING * 2) / dy), 0.25, 2.5)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      cameraRef.current = {
        scale,
        x: w / 2 - cx * scale,
        y: h / 2 - cy * scale,
      }
      onCameraChange?.(cameraRef.current)
    },
    getCamera: () => ({ ...cameraRef.current }),
  }))

  // Wheel zoom — non-passive listener so we can preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const camera = cameraRef.current
      const rect = canvas.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const wx = (mx - camera.x) / camera.scale
      const wy = (my - camera.y) / camera.scale
      const factor = event.deltaY > 0 ? 0.9 : 1.1
      const nextScale = clamp(camera.scale * factor, 0.25, 3)
      cameraRef.current = {
        scale: nextScale,
        x: mx - wx * nextScale,
        y: my - wy * nextScale,
      }
      onCameraChange?.(cameraRef.current)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onCameraChange])

  const hitTest = useCallback((clientX: number, clientY: number): PositionedNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const camera = cameraRef.current
    const x = (clientX - rect.left - camera.x) / camera.scale
    const y = (clientY - rect.top - camera.y) / camera.scale
    let best: PositionedNode | null = null
    let bestDist = Infinity
    const all = [...positionedRef.current, ...ghostsRef.current]
    for (const node of all) {
      const dx = x - node.x
      const dy = y - node.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= node.radius + 5 && dist < bestDist) {
        best = node
        bestDist = dist
      }
    }
    return best
  }, [])

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab select-none active:cursor-grabbing"
        onMouseDown={(event) => {
          const canvas = canvasRef.current
          if (!canvas) return
          const target = hitTest(event.clientX, event.clientY)
          if (target) {
            const rect = canvas.getBoundingClientRect()
            const camera = cameraRef.current
            const wx = (event.clientX - rect.left - camera.x) / camera.scale
            const wy = (event.clientY - rect.top - camera.y) / camera.scale
            // Pin the live node by id so re-positioning across re-renders preserves drag.
            const live = positionedRef.current.find((n) => n.id === target.id)
            if (live) {
              live.fx = live.x
              live.fy = live.y
            }
            dragStateRef.current = {
              kind: 'node',
              nodeId: target.id,
              offsetX: wx - target.x,
              offsetY: wy - target.y,
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
        }}
        onMouseMove={(event) => {
          const drag = dragStateRef.current
          if (drag?.kind === 'pan') {
            const dx = event.clientX - drag.startX
            const dy = event.clientY - drag.startY
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
            cameraRef.current = {
              ...drag.camera,
              x: drag.camera.x + dx,
              y: drag.camera.y + dy,
            }
            onCameraChange?.(cameraRef.current)
            return
          }
          if (drag?.kind === 'node') {
            const canvas = canvasRef.current
            if (!canvas) return
            const rect = canvas.getBoundingClientRect()
            const camera = cameraRef.current
            const wx = (event.clientX - rect.left - camera.x) / camera.scale
            const wy = (event.clientY - rect.top - camera.y) / camera.scale
            const live = positionedRef.current.find((n) => n.id === drag.nodeId)
            if (live) {
              live.fx = wx - drag.offsetX
              live.fy = wy - drag.offsetY
              live.x = live.fx
              live.y = live.fy
            }
            drag.moved = true
            sim.bump(0.4)
            return
          }
          const node = hitTest(event.clientX, event.clientY)
          onHoverNode(node)
        }}
        onMouseLeave={() => {
          onHoverNode(null)
        }}
        onMouseUp={(event) => {
          const drag = dragStateRef.current
          dragStateRef.current = null
          if (!drag) return
          if (drag.kind === 'pan' && !drag.moved) {
            const node = hitTest(event.clientX, event.clientY)
            if (node) onSelectNode(node)
          } else if (drag.kind === 'node' && !drag.moved) {
            const node = hitTest(event.clientX, event.clientY)
            if (node) onSelectNode(node)
          }
        }}
        onDoubleClick={(event) => {
          const node = hitTest(event.clientX, event.clientY)
          if (!node) return
          const live = positionedRef.current.find((n) => n.id === node.id)
          if (live) {
            live.fx = null
            live.fy = null
            sim.bump(0.6)
          }
        }}
      />
    </div>
  )
})

export default MemoryGraphCanvas

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  source: PositionedNode,
  target: PositionedNode,
  size: number,
  active: boolean
) {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist === 0) return
  const ux = dx / dist
  const uy = dy / dist
  const tipX = target.x - ux * (target.radius + 1)
  const tipY = target.y - uy * (target.radius + 1)
  const baseX = tipX - ux * size
  const baseY = tipY - uy * size
  const perpX = -uy
  const perpY = ux
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(baseX + perpX * size * 0.4, baseY + perpY * size * 0.4)
  ctx.lineTo(baseX - perpX * size * 0.4, baseY - perpY * size * 0.4)
  ctx.closePath()
  ctx.fillStyle = active ? 'rgba(165, 180, 252, 0.95)' : 'rgba(113, 113, 122, 0.6)'
  ctx.fill()
}

function pickLabelNodes(
  positioned: PositionedNode[],
  focusedNode: PositionedNode | null,
  focusNeighbors: Set<string> | null,
  zoomAlpha: number
): Array<{ node: PositionedNode; alpha: number }> {
  if (focusedNode) {
    const out: Array<{ node: PositionedNode; alpha: number }> = []
    positioned.forEach((node) => {
      if (node.id === focusedNode.id) {
        out.push({ node, alpha: 1 })
      } else if (focusNeighbors?.has(node.id)) {
        out.push({ node, alpha: 0.95 })
      }
    })
    return out
  }

  if (zoomAlpha <= 0) return []

  // Show every node when the graph is small enough to be readable; for denser
  // graphs, cap to the highest-degree nodes so labels do not overlap into mush.
  const cap = 80
  const visibleAlpha = Math.min(0.95, 0.45 + zoomAlpha * 0.55)
  const candidates = positioned.length <= cap
    ? positioned
    : [...positioned].sort((a, b) => b.degree - a.degree).slice(0, cap)
  return candidates.map((node) => ({ node, alpha: visibleAlpha }))
}

type Star = {
  x: number
  y: number
  radius: number
  baseAlpha: number
  amp: number
  period: number
  phase: number
  hue: 'white' | 'indigo' | 'cyan'
}

function generateStars(width: number, height: number): Star[] {
  // Density tuned for a calm starfield — roughly one star per 4500 px².
  const count = Math.max(40, Math.min(180, Math.round((width * height) / 4500)))
  const stars: Star[] = []
  for (let i = 0; i < count; i += 1) {
    const r = mulberry(i + 1)
    const sizeRoll = r()
    const radius = sizeRoll < 0.78 ? 0.6 + r() * 0.5 : sizeRoll < 0.96 ? 1 + r() * 0.6 : 1.6 + r() * 0.7
    const hueRoll = r()
    const hue: Star['hue'] = hueRoll < 0.82 ? 'white' : hueRoll < 0.94 ? 'indigo' : 'cyan'
    stars.push({
      x: r() * width,
      y: r() * height,
      radius,
      baseAlpha: 0.18 + r() * 0.42,
      amp: 0.12 + r() * 0.28,
      period: 1800 + r() * 4200,
      phase: r() * Math.PI * 2,
      hue,
    })
  }
  return stars
}

function drawStarfield(ctx: CanvasRenderingContext2D, stars: Star[], now: number) {
  ctx.save()
  for (const star of stars) {
    const t = (now / star.period) * Math.PI * 2 + star.phase
    const twinkle = Math.sin(t)
    const alpha = clamp01(star.baseAlpha + twinkle * star.amp)
    if (alpha <= 0.02) continue

    const rgb =
      star.hue === 'indigo'
        ? '165, 180, 252'
        : star.hue === 'cyan'
          ? '125, 211, 252'
          : '244, 244, 245'

    if (star.radius >= 1.4 && twinkle > 0.7) {
      const grad = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.radius * 4.5)
      grad.addColorStop(0, `rgba(${rgb}, ${alpha * 0.55})`)
      grad.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(star.x, star.y, star.radius * 4.5, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = `rgba(${rgb}, ${alpha})`
    ctx.beginPath()
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

// Tiny seeded PRNG so the starfield is stable across redraws of the same canvas size.
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return function rand() {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
