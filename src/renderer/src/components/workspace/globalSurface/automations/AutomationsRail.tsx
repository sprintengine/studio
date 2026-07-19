import React from 'react'

import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { StatusDot } from '../../../ui/StatusDot'
import { automationRailState } from './railState'

// The Automations surface rail (mockup §3): every automation in this Multicode
// with a status dot and one plain-language state line ("Ran 2h ago · passed",
// "Running now", "Paused", "Last run failed"), then "New automation" at the
// bottom. This is a navigation rail — selecting a row fills the canvas; the
// actions (run, edit, pause) live on the surface bar and canvas, not here — so
// it stays a calm dot + name + state line, distinct from the folder panel's
// action-dense DefinitionList.
export function AutomationsRail({
  entries, selectedId, now, onSelect, onKeyDown, onCreate,
}: {
  entries: AutomationsInstanceEntry[]
  selectedId: string | null
  now: number
  onSelect: (automationId: string) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onCreate: (anchor: { x: number; y: number }) => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-semibold text-[color:var(--text-subtle)]">Automations</div>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {entries.map((entry) => {
          const rail = automationRailState(entry, now)
          const selected = entry.definition.id === selectedId
          return (
            <li key={entry.definition.id}>
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(entry.definition.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
                  selected
                    ? 'bg-[color:var(--bg-selected)]'
                    : 'hover:bg-[color:var(--bg-hover)]'
                }`}
              >
                <StatusDot tone={rail.tone} pulse={rail.running} size={7} className="shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">
                    {entry.definition.name}
                  </span>
                  <span className="truncate text-[10.5px] text-[color:var(--text-subtle)]">{rail.text}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          onCreate({ x: rect.left, y: rect.bottom })
        }}
        className={`mt-1.5 flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
          <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        New automation
      </button>
    </div>
  )
}
