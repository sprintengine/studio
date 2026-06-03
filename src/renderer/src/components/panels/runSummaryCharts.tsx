// Hand-built SVG charts for the run summary. No charting dependency: every
// stroke/fill reads from a design token, so these stay on the calm Linear/
// Vercel-grade aesthetic (one accent, hairline gridlines, status tones only).
import React, { useEffect, useRef } from 'react'
import {
  cardinalSplinePath,
  type SprintEngineBurnup,
  type SprintEngineIssueTotal,
} from '../../utils/sprintengineRunSummary'
import { TONE_COLOR_VAR, type Tone } from '../ui/tokens'

const TABULAR: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Cumulative tasks-completed curve across the run (Vercel-style trend line). */
export function RunBurnupChart({
  burnup,
  totalTasks,
  durationLabel,
}: {
  burnup: SprintEngineBurnup
  totalTasks: number
  durationLabel: string | null
}) {
  const curveRef = useRef<SVGPathElement>(null)
  const W = 560
  const yTop = 12
  const yBot = 100
  const span = burnup.endMs - burnup.startMs || 1
  const ceiling = Math.max(totalTasks, burnup.total, 1)

  const xy = burnup.points.map((p): [number, number] => [
    ((p.atMs - burnup.startMs) / span) * W,
    yBot - (p.done / ceiling) * (yBot - yTop),
  ])
  const curve = cardinalSplinePath(xy)
  const area = `${curve} L ${W} ${yBot} L 0 ${yBot} Z`
  const end = xy[xy.length - 1]

  useEffect(() => {
    const path = curveRef.current
    if (!path || prefersReducedMotion() || typeof path.animate !== 'function') return
    let length = 0
    try {
      length = path.getTotalLength()
    } catch {
      return
    }
    if (!length) return
    const animation = path.animate(
      [{ strokeDasharray: length, strokeDashoffset: length }, { strokeDasharray: length, strokeDashoffset: 0 }],
      { duration: 850, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
    )
    return () => animation.cancel()
  }, [curve])

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-[color:var(--text-muted)]">
        <span>Tasks completed over the run</span>
        <span style={TABULAR}>{`0 → ${ceiling}`}</span>
      </div>
      <svg
        width="100%"
        height="116"
        viewBox={`0 0 ${W} 116`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Burn-up: ${burnup.total} of ${ceiling} tasks completed over ${durationLabel ?? 'the run'}`}
      >
        <line x1="0" y1={yTop + 8} x2={W} y2={yTop + 8} stroke="var(--border-subtle)" />
        <line x1="0" y1={(yTop + yBot) / 2} x2={W} y2={(yTop + yBot) / 2} stroke="var(--border-subtle)" />
        <line x1="0" y1={yBot} x2={W} y2={yBot} stroke="var(--border-strong)" />
        <path d={area} fill="var(--accent-primary-soft)" stroke="none" />
        <path
          ref={curveRef}
          d={curve}
          fill="none"
          stroke="var(--accent-primary)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={end[0]} cy={end[1]} r={3.5} fill="var(--accent-primary)" />
      </svg>
      <div className="mt-1.5 flex items-baseline justify-between text-[11px] text-[color:var(--text-disabled)]">
        <span>start</span>
        {durationLabel ? <span style={TABULAR}>{durationLabel}</span> : null}
      </div>
    </div>
  )
}

/** Thin progress ring — completion / gate pass-rate. */
export function ProgressRing({
  valuePct,
  primaryLabel,
  sublabel,
  caption,
  tone,
}: {
  valuePct: number
  primaryLabel: string
  sublabel: string
  caption: string
  tone: Tone
}) {
  const size = 92
  const r = 38
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, valuePct))
  const offset = c * (1 - clamped / 100)
  const color = TONE_COLOR_VAR[tone]
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${caption}: ${primaryLabel}, ${sublabel}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-subtle)" strokeWidth={7} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--text-strong)" style={TABULAR}>
          {primaryLabel}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontSize={10} fill="var(--text-muted)" style={TABULAR}>
          {sublabel}
        </text>
      </svg>
      <span className="text-[11px] text-[color:var(--text-muted)]">{caption}</span>
    </div>
  )
}

/** Horizontal bar chart of issue-type totals caught in review. Calm neutral
 *  fill — magnitude carries the signal, no per-type colour. */
export function IssueBars({ items }: { items: SprintEngineIssueTotal[] }) {
  const max = Math.max(1, ...items.map((item) => item.total))
  const sorted = [...items].sort((a, b) => b.total - a.total)
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((item) => (
        <div key={item.key} className="grid grid-cols-[140px_1fr_auto] items-center gap-3">
          <span className="text-[12px] text-[color:var(--text-muted)]">{item.label}</span>
          <span className="h-2 overflow-hidden rounded-[3px] bg-[color:var(--border-subtle)]">
            <span
              className="block h-full rounded-[3px] bg-[color:var(--text-muted)]"
              style={{ width: `${(item.total / max) * 100}%` }}
            />
          </span>
          <span
            className="text-right text-[13px] font-semibold tabular-nums text-[color:var(--text-strong)]"
            style={{ minWidth: '2.5ch' }}
          >
            {item.total}
          </span>
        </div>
      ))}
    </div>
  )
}
