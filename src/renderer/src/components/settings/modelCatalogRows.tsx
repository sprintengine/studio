import { useState } from 'react'

import { Popover, Switch, Tooltip, TruncatedText } from '../ui'
import { AgentCliPicker } from '../workspace/newWorkspace/SprintEngineRosterTable'
import {
  labelForCliRuntime,
  type AgentCliCatalogOption,
  type CliAvailabilityFilterStatus,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import type { AgentCli, AgentCliAvailabilityMap, SprintEngineModelCatalogEntry } from '../../types/workspace'

// Store-free presentation + pure logic for the Settings → Model catalog section
// (plan Frame B). Kept separate from the store-connected `ModelCatalogSection`
// so these pieces render and unit-test without pulling the whole workspace store
// into the bundle.

// The four fixed 1–10 axes, in display order. Kept as data so the header labels
// and each row's inputs stay in lockstep and never drift apart.
export const AXES: { key: 'intelligence' | 'frontendDesign' | 'mobile' | 'speed'; label: string }[] = [
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'frontendDesign', label: 'Frontend design' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'speed', label: 'Speed' },
]

// One editable row. Numeric fields are held as raw strings so an in-progress
// value ("0.", a momentarily-empty field, an out-of-range number) is never
// fought by coercion mid-keystroke — the T1 normalizer owns coercion, and each
// row reconciles to its normalized value on blur. `key` is a stable local
// identity so React and focus survive add/remove and cli/model edits.
export type ModelCatalogDraftRow = {
  key: number
  cli: AgentCli
  model: string | null
  offeredByDefault: boolean
  intelligence: string
  frontendDesign: string
  mobile: string
  speed: string
  cost: string
  note: string
}

const numberToField = (value: number): string => (Number.isFinite(value) ? String(value) : '')

// Blank ⇒ NaN so the T1 normalizer treats it as missing (axis ⇒ 5, cost ⇒ 1)
// rather than `Number('')`'s 0, which would wrongly clamp an axis to 1.
function fieldToNumber(raw: string): number {
  const trimmed = raw.trim()
  return trimmed === '' ? Number.NaN : Number(trimmed)
}

export function entryToDraftRow(entry: SprintEngineModelCatalogEntry, key: number): ModelCatalogDraftRow {
  return {
    key,
    cli: entry.cli,
    model: entry.model,
    offeredByDefault: entry.offeredByDefault,
    intelligence: numberToField(entry.intelligence),
    frontendDesign: numberToField(entry.frontendDesign),
    mobile: numberToField(entry.mobile),
    speed: numberToField(entry.speed),
    cost: numberToField(entry.cost),
    note: entry.note ?? '',
  }
}

// Draft → catalog entry, passing raw values straight through to the T1
// normalizer (via the store setter) — no bespoke clamping here by design.
export function draftRowToEntry(row: ModelCatalogDraftRow): SprintEngineModelCatalogEntry {
  const note = row.note.trim()
  return {
    cli: row.cli,
    model: row.model,
    offeredByDefault: row.offeredByDefault,
    intelligence: fieldToNumber(row.intelligence),
    frontendDesign: fieldToNumber(row.frontendDesign),
    mobile: fieldToNumber(row.mobile),
    speed: fieldToNumber(row.speed),
    cost: fieldToNumber(row.cost),
    ...(note ? { note } : {}),
  }
}

// A row is unavailable only when detection is trustworthy and says the CLI is
// not installed. Mirrors filterCatalogByAvailability's caution: while detection
// is loading/errored, the map is absent, or nothing is detected as installed (a
// likely-flaky probe), nothing is greyed — a CLI with no entry reads as "not
// yet probed", never as unavailable.
export function isCatalogCliUnavailable(
  cli: AgentCli,
  availabilityMap: AgentCliAvailabilityMap | null | undefined,
  status: CliAvailabilityFilterStatus,
): boolean {
  if (status !== 'ready' || !availabilityMap) return false
  const anyInstalled = Object.values(availabilityMap).some((entry) => entry.installed)
  if (!anyInstalled) return false
  return availabilityMap[cli]?.installed === false
}

// Shared column template so the header labels and every row's cells align to the
// same grid — one place to change the layout.
const GRID_TEMPLATE =
  'grid grid-cols-[56px_150px_168px_84px_84px_84px_84px_84px_minmax(160px,1fr)_32px] items-center gap-2 px-3'

export function ModelCatalogHeaderRow() {
  return (
    <div
      className={`${GRID_TEMPLATE} border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] py-2 text-[11px] font-medium text-[color:var(--text-subtle)]`}
    >
      <span>Default</span>
      <span>CLI</span>
      <span>Model</span>
      {AXES.map((axis) => (
        <span key={axis.key} className="text-right">
          {axis.label}
        </span>
      ))}
      <span className="text-right">Cost ×</span>
      <span>Note</span>
      <span className="sr-only">Actions</span>
    </div>
  )
}

const CELL_INPUT_CLASS =
  'h-7 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-2 text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45'

export function ModelCatalogRow({
  row,
  cliOption,
  installedCliOptions,
  unavailable,
  onUpdate,
  onReconcile,
  onRemove,
}: {
  row: ModelCatalogDraftRow
  cliOption: AgentCliCatalogOption | undefined
  installedCliOptions: AgentCliCatalogOption[]
  unavailable: boolean
  onUpdate: (patch: Partial<ModelCatalogDraftRow>) => void
  onReconcile: () => void
  onRemove: () => void
}) {
  const cliLabel = cliOption?.label ?? labelForCliRuntime(row.cli)
  const rowScopeLabel = `${cliLabel}${row.model ? ` ${row.model}` : ''}`
  return (
    <div className={`${GRID_TEMPLATE} bg-[color:var(--bg-surface-raised)] py-2`}>
      <Switch
        checked={row.offeredByDefault}
        onChange={(next) => onUpdate({ offeredByDefault: next })}
        ariaLabel={`Offer ${rowScopeLabel} by default in new sprints`}
      />

      <AgentCliPicker
        ariaLabel={`CLI for ${rowScopeLabel}`}
        value={row.cli}
        disabled={false}
        cliOptions={installedCliOptions}
        // Changing the CLI clears the model to the new CLI's default (null): a
        // model id from the previous CLI is meaningless under a different one.
        onChange={(cli) => onUpdate({ cli, model: null })}
      />

      <CatalogModelPicker
        ariaLabel={`Model for ${rowScopeLabel}`}
        cliOption={cliOption}
        cliLabel={cliLabel}
        value={row.model}
        onChange={(model) => onUpdate({ model })}
      />

      {AXES.map((axis) => (
        <input
          key={axis.key}
          value={row[axis.key]}
          onChange={(event) => onUpdate({ [axis.key]: event.target.value })}
          onBlur={onReconcile}
          inputMode="numeric"
          aria-label={`${axis.label} score (1–10) for ${rowScopeLabel}`}
          className={`${CELL_INPUT_CLASS} text-right font-mono tabular-nums`}
        />
      ))}

      <input
        value={row.cost}
        onChange={(event) => onUpdate({ cost: event.target.value })}
        onBlur={onReconcile}
        inputMode="decimal"
        aria-label={`Cost multiplier for ${rowScopeLabel}`}
        className={`${CELL_INPUT_CLASS} text-right font-mono tabular-nums`}
      />

      <div className="min-w-0">
        <input
          value={row.note}
          onChange={(event) => onUpdate({ note: event.target.value })}
          onBlur={onReconcile}
          placeholder="Optional guidance"
          aria-label={`Note for ${rowScopeLabel}`}
          className={CELL_INPUT_CLASS}
        />
        {unavailable ? (
          <div className="mt-1 flex items-center gap-1.5">
            <span className="rounded-[3px] bg-[color:var(--tone-warn-soft,rgba(252,192,48,0.14))] px-1.5 py-px text-[10px] font-medium text-[color:var(--tone-warn)]">
              CLI not installed
            </span>
            <span className="truncate text-[11px] text-[color:var(--text-subtle)]">
              excluded until {cliLabel} is installed
            </span>
          </div>
        ) : null}
      </div>

      <Tooltip content={`Remove ${rowScopeLabel}`} wrapperClassName="inline-flex justify-self-end">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${rowScopeLabel} from the catalog`}
          className="interactive flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
        >
          <span aria-hidden="true" className="text-[13px]">✕</span>
        </button>
      </Tooltip>
    </div>
  )
}

// Per-row model picker. Value is `string | null` (null = the CLI's own default,
// no --model flag). Offers the CLI default, the merged model options for this
// CLI (plugin seed + user-entered ids), the current value if it is no longer
// listed, and a custom-id input when the CLI allows one — the same sources the
// wizard's runtime picker draws from.
function CatalogModelPicker({
  ariaLabel,
  cliOption,
  cliLabel,
  value,
  onChange,
}: {
  ariaLabel: string
  cliOption: AgentCliCatalogOption | undefined
  cliLabel: string
  value: string | null
  onChange: (model: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [customModel, setCustomModel] = useState('')
  const modelSelection = cliOption?.modelSelection
  const options = modelSelection?.options ?? []
  const knownLabel = value ? options.find((option) => option.id === value)?.label : undefined
  const triggerLabel = value ? knownLabel ?? value : 'CLI default'
  const valueIsListed = value === null || options.some((option) => option.id === value)

  const select = (model: string | null) => {
    onChange(model)
    setOpen(false)
    setCustomModel('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setCustomModel('')
      }}
      ariaLabel={ariaLabel}
      popupRole="listbox"
      placement="bottom-start"
      className="block w-full"
      surfaceClassName="w-[220px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          aria-label={`${ariaLabel}: ${triggerLabel}`}
          onClick={togglePopover}
          className="interactive flex h-7 w-full items-center justify-between gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-2 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
          {...triggerProps}
        >
          <TruncatedText
            as="span"
            text={triggerLabel}
            className={`min-w-0 flex-1 ${value && !knownLabel ? 'font-mono' : ''}`}
          />
          <span aria-hidden="true" className="shrink-0 text-[10px] text-[color:var(--text-disabled)]">▾</span>
        </button>
      )}
    >
      <div role="listbox" aria-label={`${ariaLabel} options`} className="max-h-[240px] overflow-y-auto">
        <ModelOption label="CLI default" selected={value === null} onClick={() => select(null)} />
        {options.map((option) => (
          <ModelOption
            key={option.id}
            label={option.label ?? option.id}
            mono={!option.label}
            selected={value === option.id}
            onClick={() => select(option.id)}
          />
        ))}
        {value && !valueIsListed ? (
          <ModelOption label={value} mono selected note="Not listed" onClick={() => select(value)} />
        ) : null}
      </div>
      {modelSelection?.allowCustomId ? (
        <input
          type="text"
          value={customModel}
          placeholder="Custom model id"
          aria-label={`Custom model id for ${cliLabel}`}
          onChange={(event) => setCustomModel(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              const next = customModel.trim()
              if (next) select(next)
            }
          }}
          className="mt-1 w-full rounded-md border border-[color:var(--border-subtle)] bg-transparent px-2 py-1.5 font-mono text-[12px] text-[color:var(--text-default)] placeholder:font-sans placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] focus:outline-none"
        />
      ) : null}
    </Popover>
  )
}

function ModelOption({
  label,
  selected,
  mono,
  note,
  onClick,
}: {
  label: string
  selected: boolean
  mono?: boolean
  note?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
        mono ? 'font-mono text-[11px]' : ''
      } ${
        selected
          ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <TruncatedText as="span" text={label} className="min-w-0 flex-1" />
      {note ? <span className="shrink-0 font-sans text-[10px] text-[color:var(--text-muted)]">{note}</span> : null}
      {selected ? <span className="shrink-0 text-[color:var(--accent-primary)]">✓</span> : null}
    </button>
  )
}
