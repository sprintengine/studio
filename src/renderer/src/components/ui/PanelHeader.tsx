import React from 'react'
import { TOOL_COLOR_VAR, type ToolIdentity } from './tokens'
import { TruncatedText } from './TruncatedText'

type ProgressIndicator = {
  /** Completed units, capped to `total` for layout safety. */
  value: number
  /** Total units. When 0 or missing the indicator is hidden. */
  total: number
  /** Optional second-tone segment (e.g. blocked) drawn after the accent fill. */
  warnValue?: number
  /** Accessible label, e.g. "3 of 7 milestones accepted". */
  ariaLabel?: string
}

type PanelHeaderProps = {
  /** Small identity dot only — the rest of the panel should stay accent-neutral. */
  tool?: ToolIdentity
  title: string
  /** Use sentence case. Omit when the title is self-evident. */
  subtitle?: string
  /** Optional canonical count rendered next to the title. */
  count?: number | string
  titleId?: string
  /** At most one. Move secondary controls into overflow. */
  primaryAction?: React.ReactNode
  overflow?: React.ReactNode
  /** Optional 2px progress hairline overlaid on the header's bottom border.
   *  Use when the panel has a canonical completion metric (accepted/total) so
   *  the indicator earns its place; do not use as decoration. */
  progress?: ProgressIndicator
  /** Set false when a search row follows immediately. One divider per panel, and
   *  it belongs under the search — that is the line that says "a list starts
   *  here". A rule above the search as well boxes the search into a strip of its
   *  own and gives the panel two lines where one carries the meaning. */
  divider?: boolean
}

export function PanelHeader({
  tool,
  title,
  subtitle,
  count,
  titleId,
  primaryAction,
  overflow,
  progress,
  divider = true,
}: PanelHeaderProps) {
  const acceptedPct =
    progress && progress.total > 0
      ? Math.min(Math.max(progress.value, 0), progress.total) / progress.total
      : 0
  const warnPct =
    progress && progress.total > 0 && progress.warnValue
      ? Math.min(Math.max(progress.warnValue, 0), progress.total) / progress.total
      : 0
  return (
    <header
      className={`relative flex items-center justify-between gap-3 bg-[color:var(--bg-surface)] px-3 py-2 ${
        divider ? 'border-b border-[color:var(--border-default)]' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {tool ? (
          <span
            aria-hidden="true"
            // design-tokens-allow: tool-identity dot — per-tool accent colour cannot be expressed via StatusDot tone enum, and this is the canonical PanelHeader implementation
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: TOOL_COLOR_VAR[tool] }}
          />
        ) : null}
        <TruncatedText
          as="h2"
          id={titleId}
          text={title}
          className="text-body font-semibold text-[color:var(--text-strong)]"
        />
        {count !== undefined ? (
          <span className="tabular-nums text-meta text-[color:var(--text-muted)]">{count}</span>
        ) : null}
        {subtitle ? (
          <span className="truncate text-meta text-[color:var(--text-muted)]">
            <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">
              ·
            </span>
            {subtitle}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {primaryAction}
        {overflow}
      </div>
      {progress && progress.total > 0 ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.value}
          aria-label={progress.ariaLabel}
        >
          <div
            className="absolute inset-y-0 left-0 bg-[color:var(--accent-primary)] transition-[width] duration-200"
            style={{ width: `${acceptedPct * 100}%` }}
          />
          {warnPct > 0 ? (
            <div
              className="absolute inset-y-0 bg-[color:var(--tone-warn)] transition-[width,left] duration-200"
              style={{ left: `${acceptedPct * 100}%`, width: `${warnPct * 100}%` }}
            />
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
