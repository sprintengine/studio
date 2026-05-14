import React from 'react'
import { TYPE_COLORS, bucketForNode } from './MemoryGraphCanvas'

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
      className="pointer-events-none absolute bottom-3 left-3 rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]/85 px-3 py-2 text-[11px] text-[color:var(--text-default)] backdrop-blur-md"
      style={{ WebkitBackdropFilter: 'blur(12px)' }}
    >
      <div className="mb-1.5 text-[11px] font-semibold text-[color:var(--text-disabled)]">
        Types
      </div>
      <ul className="space-y-1">
        {entries.map(([bucket, count]) => {
          const color = TYPE_COLORS[bucket] ?? TYPE_COLORS.default
          return (
            <li key={bucket} className="flex items-center gap-2">
              <span
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: color }}
                aria-hidden
              />
              <span className="capitalize">{bucket}</span>
              <span className="tabular-nums text-[color:var(--text-disabled)]">{count}</span>
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
      className="pointer-events-none absolute z-10 max-w-[280px] rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]/85 px-3 py-2 text-[11px] text-[color:var(--text-muted)] backdrop-blur-md"
      style={{ left: x + 16, top: y + 16, WebkitBackdropFilter: 'blur(12px)' }}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-[6px] w-[6px] shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden
        />
        <span className="truncate text-[12px] font-semibold text-[color:var(--text-strong)]">
          {title}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[color:var(--text-disabled)]">
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
              className="rounded-[5px] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-muted)]"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
