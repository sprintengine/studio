import React from 'react'
import { TOOL_COLOR_VAR, type ToolIdentity } from './tokens'

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
}

export function PanelHeader({
  tool,
  title,
  subtitle,
  count,
  titleId,
  primaryAction,
  overflow,
}: PanelHeaderProps) {
  return (
    <header
      className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {tool ? (
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: TOOL_COLOR_VAR[tool] }}
          />
        ) : null}
        <h2
          id={titleId}
          className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]"
        >
          {title}
        </h2>
        {count !== undefined ? (
          <span className="tabular-nums text-[12px] text-[color:var(--text-muted)]">{count}</span>
        ) : null}
        {subtitle ? (
          <span className="truncate text-[12px] text-[color:var(--text-muted)]">
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
    </header>
  )
}
