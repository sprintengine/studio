import { useEffect, useRef } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type ForceCenter,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type SimulationLinkDatum,
} from 'd3-force'
import type { MemoryGraphForcesConfig } from '../../types/workspace'
import type { PositionedNode } from './memoryGraphTypes'

const ALPHA_MIN = 0.005
const TICK_PER_FRAME = 1

type SimulationOptions = {
  forces: MemoryGraphForcesConfig
  width: number
  height: number
  reducedMotion: boolean
}

export type GraphSimulationHandle = {
  /** Re-energise the simulation after a topology or filter change. */
  bump: (alpha?: number) => void
}

type LinkDatum = SimulationLinkDatum<PositionedNode> & { id: string }

export function useMemoryGraphSimulation(
  nodesRef: React.MutableRefObject<PositionedNode[]>,
  visibleNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options: SimulationOptions
): GraphSimulationHandle {
  const simRef = useRef<Simulation<PositionedNode, LinkDatum> | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Build the simulation once and stop its internal timer — we tick from RAF.
  useEffect(() => {
    const sim = forceSimulation<PositionedNode>([])
      .alphaDecay(0.02)
      .velocityDecay(0.32)
      .stop()

    sim.force('charge', forceManyBody<PositionedNode>().strength(-180))
    sim.force(
      'link',
      forceLink<PositionedNode, LinkDatum>([])
        .id((node) => node.id)
        .distance(90)
        .strength(0.4)
    )
    sim.force('center', forceCenter<PositionedNode>(0, 0).strength(0.2))
    sim.force(
      'collide',
      forceCollide<PositionedNode>().radius((node) => node.radius + 2).strength(0.85)
    )

    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [])

  // Re-bind the live nodes array whenever the visible set changes. The canvas
  // rebuilds nodesRef.current synchronously before this effect runs, so d3
  // ticks against the same array reference the renderer reads from.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    sim.nodes(nodesRef.current)
    sim.alpha(0.85).restart()
  }, [visibleNodes, nodesRef])

  // Wire the link force whenever the edge set changes.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const linkForce = sim.force('link') as ForceLink<PositionedNode, LinkDatum> | undefined
    if (!linkForce) return
    linkForce.links(
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }))
    )
    sim.alpha(0.7).restart()
  }, [edges])

  // Apply force tunables + viewport center whenever they change.
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return
    const { forces, width, height } = options

    const charge = sim.force('charge') as ForceManyBody<PositionedNode> | undefined
    if (charge) {
      charge.strength(-280 * Math.max(0.05, forces.repelForce))
    }
    const linkForce = sim.force('link') as ForceLink<PositionedNode, LinkDatum> | undefined
    if (linkForce) {
      linkForce.distance(forces.linkDistance).strength(forces.linkForce)
    }
    const center = sim.force('center') as ForceCenter<PositionedNode> | undefined
    if (center) {
      center.x(width / 2).y(height / 2).strength(forces.centerForce)
    }
    const collide = sim.force('collide') as ForceCollide<PositionedNode> | undefined
    if (collide) {
      collide.radius((node) => node.radius + 2)
    }
    sim.alpha(Math.max(sim.alpha(), 0.45)).restart()
  }, [
    options.forces.centerForce,
    options.forces.repelForce,
    options.forces.linkForce,
    options.forces.linkDistance,
    options.width,
    options.height,
  ])

  // Manual tick from rAF so we share a single frame budget with the renderer.
  useEffect(() => {
    let frame = 0
    let disposed = false
    const tick = () => {
      if (disposed) return
      const sim = simRef.current
      const opts = optionsRef.current
      if (sim && !opts.reducedMotion && sim.alpha() > ALPHA_MIN) {
        for (let i = 0; i < TICK_PER_FRAME; i += 1) sim.tick()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [])

  return {
    bump: (alpha = 0.6) => {
      const sim = simRef.current
      if (!sim) return
      sim.alpha(Math.max(sim.alpha(), alpha)).restart()
    },
  }
}
