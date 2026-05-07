import React from 'react'
import { TYPE_COLORS, bucketForNode } from './MemoryGraphCanvas'

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(10, 10, 30, 0.85)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  color: '#e0e0e0',
}

type LegendProps = {
  nodes: MemoryGraphNode[]
}

/**
 * Legend listing only the colour buckets present in the current graph, sorted
 * by frequency so the dominant types appear first.
 */
export function MemoryGraphLegend({ nodes }: LegendProps) {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const bucket = bucketForNode(node)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute left-3 top-3 rounded-lg px-3 py-2.5 text-[11px]"
      style={PANEL_STYLE}
    >
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/50">
        Types
      </div>
      <ul className="space-y-1">
        {entries.map(([bucket, count]) => {
          const color = TYPE_COLORS[bucket] ?? TYPE_COLORS.default
          return (
            <li key={bucket} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: color, boxShadow: `0 0 8px ${color}` }}
                aria-hidden
              />
              <span className="capitalize">{bucket}</span>
              <span className="text-white/40 tabular-nums">{count}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type TooltipProps = {
  node: MemoryGraphNode
  x: number
  y: number
}

export function MemoryGraphTooltip({ node, x, y }: TooltipProps) {
  const bucket = bucketForNode(node)
  const color = TYPE_COLORS[bucket] ?? TYPE_COLORS.default
  const title = node.title?.trim() || node.name
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[280px] rounded-md px-3 py-2 text-[11px]"
      style={{ ...PANEL_STYLE, left: x + 16, top: y + 16 }}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
          aria-hidden
        />
        <span className="truncate text-[12px] font-semibold text-white">{title}</span>
      </div>
      <div className="mt-0.5 truncate text-white/50">
        <span className="capitalize">{bucket}</span>
        {node.inboundDegree > 0 ? (
          <span> · {node.inboundDegree} inbound</span>
        ) : null}
      </div>
      {node.tags && node.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {node.tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              className="rounded-full px-1.5 py-0.5 text-[10px] text-white/70"
              style={{ background: 'rgba(255,255,255,0.07)' }}
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
