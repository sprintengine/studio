// The "Runs in" row (MC-2123): where this sprint's agents actually work.
//
// One row, rendered by both team cards — the roleless PlainAgentsPanel and the
// staffed roster summary — exactly like the Planning agent row beside it, so
// the choice can never be present in one world and absent in the other.
//
// Anatomy is that row's, deliberately: label left, value right, no sub-copy and
// no badge (ruled 2026-08-04 for this card), with the whole explanation in the
// label's tooltip. The control is `ui/Select` — the kit's select-only combobox —
// because the list grows a third rung with MC-2136 and a value list that long
// is what a Select is. It stands 4px taller than the CliModelPicker triggers
// above it; that is the kit's one select height, and hand-rolling a shorter
// combobox to match is the drift MC-2134 exists to stop.

import { Select, Tooltip } from '../../ui'
import {
  SPRINT_ISOLATION_ITEMS,
  SPRINT_ISOLATION_ROW_LABEL,
  SPRINT_ISOLATION_TOOLTIP,
  type SprintIsolation,
} from './newSprintModel'

export type SprintIsolationRow = {
  value: SprintIsolation
  onChange: (value: SprintIsolation) => void
}

export function SprintIsolationRowView({ row }: { row: SprintIsolationRow }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-3.5 py-3">
      <Tooltip content={SPRINT_ISOLATION_TOOLTIP}>
        <span
          tabIndex={0}
          className="min-w-0 rounded-[3px] text-body font-semibold text-[color:var(--text-strong)] focus-visible:focus-ring"
        >
          {SPRINT_ISOLATION_ROW_LABEL}
        </span>
      </Tooltip>
      <Select<SprintIsolation>
        ariaLabel={SPRINT_ISOLATION_ROW_LABEL}
        items={[...SPRINT_ISOLATION_ITEMS]}
        value={row.value}
        onChange={row.onChange}
        className="shrink-0"
        triggerMinWidthClassName="min-w-[168px]"
      />
    </div>
  )
}
