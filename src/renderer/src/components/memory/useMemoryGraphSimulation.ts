import { useEffect, useRef } from 'react'
import type { MemoryGraphForcesConfig } from '../../types/workspace'
import type { PositionedNode } from './memoryGraphTypes'

const COOLING = 0.985
const VELOCITY_DECAY = 0.78
const MAX_STEP = 12

type SimulationOptions = {
  forces: MemoryGraphForcesConfig
  width: number
  height: number
  isDragging: boolean
  reducedMotion: boolean
}

export type GraphSimulationHandle = {
  /**
   * Reset the simulation alpha so the layout settles again, e.g. after
   * filters change or new nodes are introduced.
   */
  bump: (alpha?: number) => void
}

export function useMemoryGraphSimulation(
  nodesRef: React.MutableRefObject<PositionedNode[]>,
  edges: MemoryGraphEdge[],
  options: SimulationOptions
): GraphSimulationHandle {
  const alphaRef = useRef(1)
  const optionsRef = useRef(options)
  const edgesRef = useRef(edges)
  optionsRef.current = options
  edgesRef.current = edges

  useEffect(() => {
    alphaRef.current = 1
  }, [edges])

  useEffect(() => {
    let frame = 0
    let disposed = false

    const tick = () => {
      if (disposed) return
      const opts = optionsRef.current
      const nodes = nodesRef.current
      const alpha = alphaRef.current

      if (!opts.reducedMotion && alpha > 0.005 && nodes.length > 0) {
        step(nodes, edgesRef.current, opts, alpha)
        alphaRef.current = alpha * COOLING
      } else if (opts.isDragging && nodes.length > 0) {
        step(nodes, edgesRef.current, opts, Math.max(0.2, alpha))
      }

      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [nodesRef])

  return {
    bump: (alpha = 1) => {
      alphaRef.current = Math.max(alphaRef.current, alpha)
    },
  }
}

function step(
  nodes: PositionedNode[],
  edges: MemoryGraphEdge[],
  options: SimulationOptions,
  alpha: number
): void {
  const { forces, width, height } = options
  const centerX = width / 2
  const centerY = height / 2
  const repelStrength = 220 * forces.repelForce
  const linkStrength = 0.06 * forces.linkForce
  const centerStrength = 0.0015 * forces.centerForce
  const linkDistance = forces.linkDistance

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const))

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      let distSq = dx * dx + dy * dy
      const minDist = a.radius + b.radius + 4
      const minDistSq = minDist * minDist
      if (distSq < 0.01) distSq = 0.01
      const dist = Math.sqrt(distSq)

      const force = repelStrength / distSq
      const fx = (dx / dist) * force * alpha
      const fy = (dy / dist) * force * alpha
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy

      if (distSq < minDistSq) {
        const overlap = (minDist - dist) * 0.5
        const ox = (dx / dist) * overlap
        const oy = (dy / dist) * overlap
        if (a.fx === null) { a.x += ox; }
        if (a.fy === null) { a.y += oy; }
        if (b.fx === null) { b.x -= ox; }
        if (b.fy === null) { b.y -= oy; }
      }
    }
  }

  edges.forEach((edge) => {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) return
    const dx = target.x - source.x
    const dy = target.y - source.y
    const distance = Math.max(0.1, Math.sqrt(dx * dx + dy * dy))
    const desired = linkDistance + (source.radius + target.radius) * 0.5
    const force = (distance - desired) * linkStrength * alpha
    const fx = (dx / distance) * force
    const fy = (dy / distance) * force
    source.vx += fx
    source.vy += fy
    target.vx -= fx
    target.vy -= fy
  })

  nodes.forEach((node) => {
    node.vx += (centerX - node.x) * centerStrength * alpha
    node.vy += (centerY - node.y) * centerStrength * alpha

    node.vx *= VELOCITY_DECAY
    node.vy *= VELOCITY_DECAY

    if (node.fx !== null) {
      node.x = node.fx
      node.vx = 0
    } else {
      const dx = clamp(node.vx, -MAX_STEP, MAX_STEP)
      node.x += dx
    }
    if (node.fy !== null) {
      node.y = node.fy
      node.vy = 0
    } else {
      const dy = clamp(node.vy, -MAX_STEP, MAX_STEP)
      node.y += dy
    }
  })
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
