import React from 'react'

import {
  EmptyState,
  GhostButton,
  LifecycleGlyph,
  OverflowMenu,
  type OverflowMenuItem,
  PrimaryButton,
  RowButton,
  Spinner,
  TruncatedText,
} from '../../ui'
import type { AutomationDefinition } from '../../../../../shared/automations/contracts'
import {
  DEFINITION_LIFECYCLE,
  DEFINITION_STATUS_LABEL,
  absoluteTime,
  isOverdue,
  parseTime,
  relativeFromNow,
  triggerDetail,
  triggerFamilyLabel,
} from './automationsFormat'
import { ModuleAttribution } from './ModuleAttribution'

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
      <div className="w-full shrink-0 md:w-[340px] md:border-r md:border-[color:var(--border-default)]">
        <EmptyState
          title="No automations yet"
          body="Schedule an agent to run on this project — a nightly review, a recurring check."
          action={<PrimaryButton onClick={onCreate}>New automation</PrimaryButton>}
        />
      </div>
    )
  }
  return (
    <ul
      ref={ref}
      aria-label="Automations. Use j and k or the arrow keys to move between automations."
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="w-full shrink-0 py-1 outline-none focus-visible:focus-ring-inset md:w-[340px] md:overflow-y-auto md:border-r md:border-[color:var(--border-default)]"
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
  def,
  selected,
  busy,
  now,
  onSelect,
  onRunNow,
  onToggleStatus,
  onEdit,
  onDelete,
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
  // Config-specific detail (cadence, watched source/event, webhook path). Null for
  // non-schedule families with no distinguishing config — the row then shows the
  // family label alone rather than restating it.
  const detail = triggerDetail(def.trigger)
  const statusLabel = def.status === 'enabled' && overdue ? 'Overdue' : DEFINITION_STATUS_LABEL[def.status]
  // The right-side text label is earned only by exceptions (overdue, paused,
  // blocked). A healthy enabled row leans on the glyph alone — the live dot
  // already carries "enabled", so repeating it as text is redundant chrome.
  const showStatusText = overdue || def.status === 'paused' || def.status === 'blocked'

  const overflowItems: OverflowMenuItem[] = [
    { id: 'toggle', label: def.status === 'enabled' ? 'Pause' : 'Enable', onSelect: onToggleStatus, disabled: busy },
    { id: 'edit', label: 'Edit', onSelect: onEdit, disabled: busy },
    { kind: 'separator', id: 'sep' },
    { id: 'delete', label: 'Delete', onSelect: onDelete, disabled: busy, destructive: true },
  ]

  return (
    <li
      id={`automation-row-${def.id}`}
      aria-current={selected ? 'true' : undefined}
      // The whole row selects, not just the title: the trailing-actions row below
      // reserves height even at rest, so a button wrapping only the text leaves a
      // dead zone over the rest of the row. The row click is a mouse convenience;
      // the inner button remains the keyboard/AT control (the list owns j/k/arrow
      // navigation), and the trailing actions stop propagation so they don't also
      // select.
      onClick={onSelect}
      className={[
        // The row's inset now belongs to `RowButton density="flush"` (the kit
        // owns a row's padding); this element keeps the ground, the hairline and
        // the click convenience, and the trailing strip below matches the row's
        // inset with the same `px-2`.
        'group relative cursor-pointer border-b border-[color:var(--border-subtle)] transition-colors',
        selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]',
      ].join(' ')}
    >
      <RowButton density="flush" onClick={onSelect}>
        {busy ? (
          <Spinner size={14} label="Working" />
        ) : (
          <LifecycleGlyph
            state={DEFINITION_LIFECYCLE[def.status]}
            live={def.status === 'enabled'}
            label={statusLabel}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            {/* The ink lift is selection's second channel, so the title has to
                sit below the lifted one at rest — pinned at `--text-strong` it
                had nowhere to go (ui/InboxRow carries the same pair). */}
            <TruncatedText
              as="span"
              text={def.name}
              className={`text-meta font-medium ${
                selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
              }`}
            />
            {def.ownerModuleId ? <ModuleAttribution moduleId={def.ownerModuleId} className="text-micro" /> : null}
            {showStatusText ? (
              <span
                className={[
                  'shrink-0 text-micro',
                  overdue ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-subtle)]',
                ].join(' ')}
              >
                {statusLabel}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-micro text-[color:var(--text-muted)]">
            <span className="text-[color:var(--text-subtle)]">{triggerFamilyLabel(def.trigger)}</span>
            {detail !== null ? (
              <>
                <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">
                  ·
                </span>
                {detail}
              </>
            ) : null}
            <span aria-hidden="true" className="mx-1.5 text-[color:var(--text-disabled)]">
              ·
            </span>
            {nextAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(nextAt)}>
                {overdue ? 'Was due ' : 'Next '}
                {relativeFromNow(nextAt, now)}
              </span>
            ) : lastAt !== null ? (
              <span className="tabular-nums" title={absoluteTime(lastAt)}>
                Ran {relativeFromNow(lastAt, now)}
              </span>
            ) : (
              <span>No upcoming run</span>
            )}
          </div>
        </div>
      </RowButton>

      {/* Trailing actions: revealed on hover/focus/selection so a resting row stays calm.
          Run now is the one resting affordance; Pause/Enable, Edit and Delete live in the
          overflow menu so a row never shows more than two trailing controls at rest.

          Only the controls themselves stop propagation, never this container: it spans the
          row's full width, and an opacity-0 container still takes hits — swallowing clicks
          here would leave a dead strip beside the buttons that never selects the row. */}
      <div
        className={[
          'flex items-center gap-1 pb-1.5 pl-8 pr-2 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        ].join(' ')}
      >
        <GhostButton
          onClick={(e) => {
            e.stopPropagation()
            onRunNow()
          }}
          disabled={busy || def.status === 'paused'}
          size="xs"
        >
          Run now
        </GhostButton>
        <span onClick={(e) => e.stopPropagation()} className="flex items-center">
          <OverflowMenu ariaLabel={`More actions for ${def.name}`} items={overflowItems} />
        </span>
      </div>
    </li>
  )
}

export function DetailEmptyState({ hasDefinitions }: { hasDefinitions: boolean }) {
  return (
    <EmptyState
      title={
        hasDefinitions
          ? 'Select an automation to see its run history and details.'
          : 'Create an automation to schedule agents on this project.'
      }
    />
  )
}
