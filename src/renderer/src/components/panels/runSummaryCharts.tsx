// Hand-built SVG charts for the run summary. No charting dependency: every
// stroke/fill reads from a design token, so these stay on the calm Linear/
// Vercel-grade aesthetic (one accent, hairline gridlines, status tones only).
import React, { useEffect, useRef, useState } from 'react'
import {
  formatRunDuration,
  monotoneCubicPath,
  type SprintEngineActivityTimeline,
  type SprintEngineBurnup,
  type SprintEngineIssueTotal,
} from '../../utils/sprintengineRunSummary'
import { getSprintEngineRoleLabel, sprintEngineTaskStateLabel } from '../../utils/sprintengine'
import { RoleGlyph } from '../ui'
import { FOCUS_RING_CLASS, TONE_COLOR_VAR, type Tone } from '../ui/tokens'

const TABULAR: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Track an element's rendered pixel width so charts can draw in true 1:1
// coordinates instead of stretching a fixed viewBox. A stretched viewBox
// (preserveAspectRatio="none") distorts circles into ellipses and breaks
// stroke-dash draw-on animations (the dash length no longer matches the
// on-screen path length), so we measure and render at real width instead.
function useMeasuredWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      if (next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
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
  const [wrapRef, measuredWidth] = useMeasuredWidth()
  // Draw in true pixel space (1:1 viewBox) so nothing is stretched. Fall back to
  // a sensible width for the first paint before the observer reports.
  const W = measuredWidth || 560
  const H = 116
  const yTop = 12
  const yBot = 100
  const span = burnup.endMs - burnup.startMs || 1
  const ceiling = Math.max(totalTasks, burnup.total, 1)

  const xy = burnup.points.map((p): [number, number] => [
    ((p.atMs - burnup.startMs) / span) * W,
    yBot - (p.done / ceiling) * (yBot - yTop),
  ])
  const curve = monotoneCubicPath(xy)
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
      <div className="mb-1.5 flex items-baseline justify-between text-micro text-[color:var(--text-muted)]">
        <span>Tasks completed over the run</span>
        <span style={TABULAR}>{`0 → ${ceiling}`}</span>
      </div>
      <div ref={wrapRef}>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
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
          />
          {/* Round endpoint marker — a true circle now the space is 1:1. */}
          <circle cx={end[0]} cy={end[1]} r={3.5} fill="var(--accent-primary)" />
        </svg>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-micro text-[color:var(--text-disabled)]">
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
      <span className="text-micro text-[color:var(--text-muted)]">{caption}</span>
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
          <span className="text-meta text-[color:var(--text-muted)]">{item.label}</span>
          <span className="h-2 overflow-hidden rounded-[3px] bg-[color:var(--border-subtle)]">
            <span
              className="block h-full rounded-[3px] bg-[color:var(--text-muted)]"
              style={{ width: `${(item.total / max) * 100}%` }}
            />
          </span>
          <span
            className="text-right text-body font-semibold tabular-nums text-[color:var(--text-strong)]"
            style={{ minWidth: '2.5ch' }}
          >
            {item.total}
          </span>
        </div>
      ))}
    </div>
  )
}

// Shared geometry so the lane tracks and the time axis line up under one grid.
const LANE_GRID = 'grid grid-cols-[150px_minmax(0,1fr)] gap-3'

/** Per-agent activity swimlane (Tier 1): one lane per agent, with accent bars for
 *  the stretches they held a task, on the same wall-clock as the burn-up above.
 *  Clicking an agent solos their lane. Honest about its data — it shows when an
 *  agent was responsible for a task, not inferred idle/paused detail. */
export function AgentActivityTimeline({
  timeline,
  durationLabel,
}: {
  timeline: SprintEngineActivityTimeline
  durationLabel: string | null
}) {
  const [soloAgentId, setSoloAgentId] = useState<string | null>(null)
  const span = timeline.endMs - timeline.startMs || 1
  const leftPct = (ms: number) => ((ms - timeline.startMs) / span) * 100

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between text-micro text-[color:var(--text-muted)]">
        <span>Time each agent spent on tasks</span>
        <span style={TABULAR}>{`${timeline.rows.length} agent${timeline.rows.length === 1 ? '' : 's'}`}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {timeline.rows.map((row) => {
          const dimmed = soloAgentId !== null && soloAgentId !== row.agentId
          const soloed = soloAgentId === row.agentId
          // The row is the agent; its role only prefixes the spoken label when
          // it has one, so a roleless agent is never announced as "Unknown role".
          const roleLabel = row.role ? getSprintEngineRoleLabel(row.role) : null
          const activeLabel = formatRunDuration(row.activeMs) ?? '< 1m'
          const taskCount = row.segments.length
          return (
            <div
              key={row.agentId}
              className={`${LANE_GRID} items-center transition-opacity ${dimmed ? 'opacity-30' : 'opacity-100'}`}
            >
              <button
                type="button"
                onClick={() => setSoloAgentId((current) => (current === row.agentId ? null : row.agentId))}
                aria-pressed={soloed}
                aria-label={`${roleLabel ? `${roleLabel} ` : ''}${row.agentId}: ${taskCount} task${taskCount === 1 ? '' : 's'}, ${activeLabel} on tasks${soloed ? ' — filtered' : ''}`}
                className={`group inline-flex min-w-0 items-baseline gap-2 rounded-sm text-left ${FOCUS_RING_CLASS}`}
              >
                {row.role ? <RoleGlyph role={row.role} size="sm" className="translate-y-[2px]" /> : null}
                <span className="truncate font-mono text-meta text-[color:var(--text-strong)]">{row.agentId}</span>
              </button>
              <div className="relative h-4">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[color:var(--border-subtle)]" />
                {row.segments.map((seg, index) => {
                  const widthPct = leftPct(seg.endMs) - leftPct(seg.startMs)
                  const phase = sprintEngineTaskStateLabel[seg.status] ?? seg.status
                  const duration = formatRunDuration(seg.endMs - seg.startMs) ?? '< 1m'
                  return (
                    <span
                      key={`${seg.taskId}-${index}`}
                      title={`${seg.taskId} · ${phase} · ${duration}`}
                      aria-hidden="true"
                      className="absolute top-1/2 h-2 -translate-y-1/2 rounded-[3px] bg-[color:var(--accent-primary)]"
                      style={{ left: `${leftPct(seg.startMs)}%`, width: `max(2px, ${widthPct}%)` }}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Time axis, aligned to the lane tracks via the shared grid. */}
      <div className={`mt-2 ${LANE_GRID} text-micro text-[color:var(--text-disabled)]`}>
        <span aria-hidden="true" />
        <div className="flex items-baseline justify-between">
          <span>start</span>
          {durationLabel ? <span style={TABULAR}>{durationLabel}</span> : null}
        </div>
      </div>

      <div className="mt-2 text-micro text-[color:var(--text-disabled)]">
        Each bar is time a task was assigned to that agent · click an agent to solo
      </div>
    </div>
  )
}
