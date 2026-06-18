import React from 'react'

import { GhostButton, IconButton, LifecycleGlyph, PrimaryButton, Spinner } from '../../ui'
import type { AutomationDefinition } from '../../../../../shared/automations/contracts'
import {
  DEFINITION_LIFECYCLE,
  DEFINITION_STATUS_LABEL,
  absoluteTime,
  cadenceSummary,
  isOverdue,
  parseTime,
  relativeFromNow,
} from './automationsFormat'

type DefinitionListProps = {
  definitions: AutomationDefinition[]
  selectedId: string | null
  busyId: string | null
  now: number
  onSelect: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onRunNow: (def: AutomationDefinition) => void
  onToggleStatus: (def: AutomationDefinition) => void
  onEdit: (def: AutomationDefinition) => void
  onDelete: (def: AutomationDefinition) => void
  onCreate: () => void
}

export const DefinitionList = React.forwardRef<HTMLUListElement, DefinitionListProps>(function DefinitionList(
  { definitions, selectedId, busyId, now, onSelect, onKeyDown, onRunNow, onToggleStatus, onEdit, onDelete, onCreate },
  ref,
) {
  if (definitions.length === 0) {
    return (
      <div className="flex w-full shrink-0 flex-col items-center justify-center gap-3 px-6 py-10 text-center md:w-[340px] md:border-r md:border-[color:var(--border-default)]">
        <p className="text-[12px] font-medium text-[color:var(--text-strong)]">No automations yet</p>
        <p className="max-w-[15rem] text-[11px] leading-5 text-[color:var(--text-muted)]">
          Schedule an agent to run on this project — a nightly review, a recurring check.
        </p>
        <PrimaryButton onClick={onCreate}>New automation</PrimaryButton>
      </div>
    )
  }
  return (
    <ul
      ref={ref}
      aria-label="Automations. Use j and k or the arrow keys to move between automations."
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="w-full shrink-0 py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)] md:w-[340px] md:overflow-y-auto md:border-r md:border-[color:var(--border-default)]"
    >
      {definitions.map((def) => (
        <DefinitionRow
          key={def.id}
          def={def}
          selected={def.id === selectedId}
          busy={busyId === def.id}
          now={now}
          onSelect={() => onSelect(def.id)}
          onRunNow={() => onRunNow(def)}
          onToggleStatus={() => onToggleStatus(def)}
          onEdit={() => onEdit(def)}
          onDelete={() => onDelete(def)}
        />
      ))}
    </ul>
  )
})

function DefinitionRow({
  def, selected, busy, now, onSelect, onRunNow, onToggleStatus, onEdit, onDelete,
}: {
  def: AutomationDefinition
  selected: boolean
  busy: boolean
  now: number
  onSelect: () => void
  onRunNow: () => void
  onToggleStatus: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const overdue = isOverdue(def, now)
  const nextAt = parseTime(def.nextRunAt)
  const lastAt = parseTime(def.lastRunAt)
  const statusLabel = def.status === 'enabled' && overdue ? 'Overdue' : DEFINITION_STATUS_LABEL[def.status]

  return (
    <li
      id={`automation-row-${def.id}`}
      aria-current={selected ? 'true' : undefined}
      className={[
        'group relative border-b border-[color:var(--border-subtle)] py-2 transition-colors',
        selected
          ? 'border-l-[3px] border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] pl-[13px] pr-3'
          : 'px-4 hover:bg-[color:var(--bg-hover)]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2 text-left outline-none"
      >
        {busy ? (
          <Spinner size={14} label="Working" className="mt-[2px]" />
        ) : (
          <LifecycleGlyph
            state={DEFINITION_LIFECYCLE[def.status]}
            live={def.status === 'enabled'}
            label={statusLabel}
            className="mt-[1px] translate-y-[1px]"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">{def.name}</span>
            <span
              className={[
                'shrink-0 text-[10px]',
                overdue ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-subtle)]',
              ].join(' ')}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[color:var(--text-muted)]">
            {cadenceSummary(def.trigger)}
            <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">·</span>
            {nextAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(nextAt)}>
                {overdue ? 'Was due ' : 'Next '}{relativeFromNow(nextAt, now)}
              </span>
            ) : lastAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(lastAt)}>Ran {relativeFromNow(lastAt, now)}</span>
            ) : (
              <span>No upcoming run</span>
            )}
          </div>
        </div>
      </button>

      {/* Trailing actions: revealed on hover/focus/selection so a resting row stays calm. */}
      <div
        className={[
          'mt-1.5 flex items-center gap-1 pl-6 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        ].join(' ')}
      >
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onRunNow() }}
          disabled={busy || def.status === 'paused'}
          className="h-6 px-2 text-[11px]"
        >
          Run now
        </GhostButton>
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onToggleStatus() }}
          disabled={busy}
          className="h-6 px-2 text-[11px]"
        >
          {def.status === 'enabled' ? 'Pause' : 'Enable'}
        </GhostButton>
        <GhostButton
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          disabled={busy}
          className="h-6 px-2 text-[11px]"
        >
          Edit
        </GhostButton>
        <IconButton
          aria-label={`Delete ${def.name}`}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          disabled={busy}
          className="h-6 w-6"
        >
          <svg viewBox="0 0 16 16" className="icon-xs" fill="none" aria-hidden="true">
            <path d="M3.5 4.5h9M6.5 4.5V3.5h3v1M5 4.5l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>
      </div>
    </li>
  )
}

export function DetailEmptyState({ hasDefinitions }: { hasDefinitions: boolean }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="max-w-xs text-[11px] leading-5 text-[color:var(--text-muted)]">
        {hasDefinitions
          ? 'Select an automation to see its run history and details.'
          : 'Create an automation to schedule agents on this project.'}
      </p>
    </div>
  )
}
