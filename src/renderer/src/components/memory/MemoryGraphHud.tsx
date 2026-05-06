import React from 'react'

type ZoomHudProps = {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onReset: () => void
}

export function MemoryGraphZoomHud({ scale, onZoomIn, onZoomOut, onFit, onReset }: ZoomHudProps) {
  const percent = Math.round(scale * 100)
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/85 p-0.5 backdrop-blur-sm">
      <HudButton onClick={onZoomOut} title="Zoom out" ariaLabel="Zoom out">
        −
      </HudButton>
      <span className="inline-flex min-w-[44px] items-center justify-center px-1 font-mono text-[11px] text-zinc-500 tabular-nums">
        {percent}%
      </span>
      <HudButton onClick={onZoomIn} title="Zoom in" ariaLabel="Zoom in">
        +
      </HudButton>
      <span className="mx-0.5 h-4 w-px bg-zinc-800" aria-hidden />
      <HudButton onClick={onFit} title="Fit to view (F)" ariaLabel="Fit to view">
        ⊙
      </HudButton>
      <HudButton onClick={onReset} title="Reset view (R)" ariaLabel="Reset view">
        ⟲
      </HudButton>
    </div>
  )
}

function HudButton({
  onClick,
  children,
  title,
  ariaLabel,
}: {
  onClick: () => void
  children: React.ReactNode
  title: string
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 min-w-[26px] items-center justify-center rounded px-1 text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}

type StatsProps = {
  noteCount: number
  linkCount: number
  orphanCount: number
  unresolvedCount: number
  topConnected: string[]
}

export function MemoryGraphStats({
  noteCount,
  linkCount,
  orphanCount,
  unresolvedCount,
  topConnected,
}: StatsProps) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-[360px] space-y-1 rounded-md border border-zinc-800 bg-zinc-900/85 px-3 py-2 text-[11px] text-zinc-400 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          <span className="font-semibold text-zinc-100 tabular-nums">{noteCount}</span>{' '}
          {noteCount === 1 ? 'note' : 'notes'}
        </span>
        <span>
          <span className="font-semibold text-zinc-100 tabular-nums">{linkCount}</span>{' '}
          {linkCount === 1 ? 'link' : 'links'}
        </span>
        {orphanCount > 0 ? (
          <span>
            <span className="font-semibold text-zinc-100 tabular-nums">{orphanCount}</span>{' '}
            {orphanCount === 1 ? 'orphan' : 'orphans'}
          </span>
        ) : null}
      </div>
      {topConnected.length > 0 ? (
        <div className="truncate text-zinc-500">
          Most connected: <span className="text-zinc-300">{topConnected.join(', ')}</span>
        </div>
      ) : null}
      {unresolvedCount > 0 ? (
        <div className="text-amber-400">
          {unresolvedCount} unresolved local link{unresolvedCount === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  )
}

type TooltipProps = {
  node: MemoryGraphNode
  x: number
  y: number
}

export function MemoryGraphTooltip({ node, x, y }: TooltipProps) {
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[260px] rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 shadow-lg"
      style={{ left: x + 14, top: y + 14 }}
    >
      <div className="truncate font-semibold text-zinc-100">{node.name}</div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
        {node.relativePath} · {node.degree} link{node.degree === 1 ? '' : 's'}
      </div>
    </div>
  )
}
