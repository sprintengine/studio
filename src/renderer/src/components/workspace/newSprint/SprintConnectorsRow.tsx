// The "Connectors" row (MC-2124): which MCP servers this sprint's agents launch
// with, chosen where the sprint is started.
//
// Anatomy is the row beside it — label left, value right, no sub-copy, the whole
// explanation in the label's tooltip — and it renders on BOTH team cards for the
// same reason "Runs in" does: a control present in one world and absent in the
// other is how the wizard-to-dialog simplification lost these capabilities in
// the first place.
//
// The value opens a picker rather than an inline list: the right pane is
// deliberately sparse, and this is the pattern the roster already uses. The
// picker is `ui/Popover` with `menuitemcheckbox` rows — a multi-toggle, so a
// pick does NOT close it — anatomically the ProjectChip menu in the same dialog.
// The trigger wears the `ui/Select` trigger's geometry so the card's three
// value controls line up; it is not a Select because a Select carries one value
// and this carries a set.

import { useState } from 'react'

import { FOCUS_RING_CLASS, MENU_ROW_CLASS, Popover, Tooltip } from '../../ui'
import { CheckIcon } from '../../AppIcons'
import {
  SPRINT_CONNECTORS_EMPTY,
  SPRINT_CONNECTORS_ROW_LABEL,
  SPRINT_CONNECTORS_SYNC_OFF,
  SPRINT_CONNECTORS_TOOLTIP,
  sprintConnectorsSummary,
  type SprintConnector,
} from './sprintConnectors'

export type SprintConnectorsRow = {
  connectors: readonly SprintConnector[]
  /** App-level MCP sync. Off means no connector reaches any agent. */
  syncEnabled: boolean
  onToggle: (serverId: string) => void
}

export function SprintConnectorsRowView({ row }: { row: SprintConnectorsRow }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = sprintConnectorsSummary(row.connectors, row.syncEnabled)
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-default)] px-3.5 py-3">
      <Tooltip content={SPRINT_CONNECTORS_TOOLTIP}>
        <span
          tabIndex={0}
          className="min-w-0 rounded-[3px] text-body font-semibold text-[color:var(--text-strong)] focus-visible:focus-ring"
        >
          {SPRINT_CONNECTORS_ROW_LABEL}
        </span>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel={SPRINT_CONNECTORS_ROW_LABEL}
        popupRole="menu"
        placement="bottom-end"
        className="shrink-0"
        surfaceClassName="max-h-[280px] w-[300px] overflow-y-auto p-1"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <button
            ref={ref}
            type="button"
            // The name carries the VALUE as well as the label: an `aria-label`
            // of "Connectors" alone would replace the summary this button
            // renders, leaving a screen reader with the control but not its
            // answer.
            aria-label={`${SPRINT_CONNECTORS_ROW_LABEL} — ${summary}`}
            onClick={togglePopover}
            className={[
              'interactive inline-flex h-control-sm min-w-[168px] items-center justify-between gap-2',
              'rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-left text-body',
              'text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
            {...triggerProps}
          >
            <span className="min-w-0 flex-1 truncate">{summary}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              aria-hidden="true"
              focusable="false"
              className="shrink-0 text-[color:var(--text-muted)]"
            >
              <path
                d="M2 4l3 3 3-3"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      >
        {row.connectors.length === 0 ? (
          <p className="px-2.5 py-3 text-meta text-[color:var(--text-muted)]">
            {SPRINT_CONNECTORS_EMPTY}
          </p>
        ) : (
          <>
            {!row.syncEnabled ? (
              <p className="px-2.5 py-2 text-micro text-[color:var(--text-muted)]">
                {SPRINT_CONNECTORS_SYNC_OFF}
              </p>
            ) : null}
            {row.connectors.map((connector) => (
              <button
                key={connector.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={connector.enabled}
                // A multi-toggle: the picker stays open so a run's whole set is
                // chosen in one visit.
                onClick={() => row.onToggle(connector.id)}
                className={`${MENU_ROW_CLASS} w-full cursor-pointer text-meta text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
              >
                <span className="min-w-0 flex-1 truncate text-left">{connector.name}</span>
                {connector.enabled ? (
                  <CheckIcon className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
                ) : null}
              </button>
            ))}
          </>
        )}
      </Popover>
    </div>
  )
}
