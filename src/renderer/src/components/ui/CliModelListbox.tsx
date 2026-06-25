import React from 'react'
import CliIcon from '../CliIcon'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import { TruncatedText } from './TruncatedText'
import type { AgentCli } from '../../types/workspace'
import type { PluginModelCatalog } from '../../../../shared/plugin-manifest'

// Structurally compatible with AgentCliCatalogOption from
// newWorkspace/cliRuntimeOptions; declared here so the ui primitive does not
// import from a workspace module.
export type CliModelListboxOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
}

// Compact "CLI · model" trigger button wrapping CliModelListbox in a popover.
// Shared by the Sprint Engine roster runtime pickers (new-workspace roster
// rows, board add-member dialog). Selecting a CLI or model closes the popover.
export function CliModelPickerButton({
  ariaLabel,
  options,
  cli,
  effectiveModelFor,
  disabled,
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  options: CliModelListboxOption[]
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  disabled?: boolean
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const resolvedOptions = options.some((option) => option.value === cli)
    ? options
    : [{ value: cli, label: cli }, ...options]
  const selected = resolvedOptions.find((option) => option.value === cli) ?? resolvedOptions[0]
  if (!selected) return null
  const model = effectiveModelFor(cli)
  const modelLabel = model
    ? selected.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
    : null
  const triggerLabel = modelLabel ? `${selected.label} · ${modelLabel}` : selected.label
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="dialog"
      placement="bottom-end"
      className="shrink-0"
      surfaceClassName="w-[220px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={`Agent runtime: ${triggerLabel}`} wrapperClassName="inline-flex">
          <button
            ref={ref}
            type="button"
            aria-label={`${ariaLabel}: ${triggerLabel}`}
            disabled={disabled}
            onClick={togglePopover}
            className="
              interactive inline-flex h-7 min-w-[140px] max-w-[220px] items-center justify-between gap-2 rounded-md border border-[color:var(--color-5)]
              bg-[color:var(--bg-surface-raised)] px-2 text-left text-[12px] text-[color:var(--text-default)] transition-colors
              hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              disabled:cursor-not-allowed disabled:opacity-45
            "
            {...triggerProps}
          >
            <span className="flex min-w-0 items-center gap-2">
              <CliIcon cli={selected.value} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
              <span className="truncate">{triggerLabel}</span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-[10px] text-[color:var(--text-disabled)]">▾</span>
          </button>
        </Tooltip>
      )}
    >
      <CliModelListbox
        ariaLabel={`${ariaLabel} options`}
        options={resolvedOptions}
        currentCli={cli}
        effectiveModelFor={effectiveModelFor}
        onSelectCli={(nextCli) => {
          onSelectCli(nextCli)
          setOpen(false)
        }}
        onSelectModel={(nextCli, nextModel) => {
          onSelectModel(nextCli, nextModel)
          setOpen(false)
        }}
      />
    </Popover>
  )
}

// One selectable runtime row: CLI brand icon + label, with a check when active.
// `mono` renders raw model ids (no friendly label) in the mono face. `note` is a
// muted trailing annotation — used to flag a persisted model id that is no longer
// in the CLI's model list, so it reads as deliberate rather than a normal choice.
function CliModelRow({
  icon,
  label,
  selected,
  mono,
  note,
  onClick,
}: {
  icon: AgentCli
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
          : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <CliIcon cli={icon} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
      <TruncatedText as="span" text={label} className="min-w-0 flex-1" />
      {note ? (
        <span className="shrink-0 font-sans text-[10px] text-[color:var(--text-muted)]">{note}</span>
      ) : null}
      {selected ? <span className="shrink-0 text-[color:var(--accent-primary)]">✓</span> : null}
    </button>
  )
}

// Flat runtime listbox shared by the top-bar spawn-row chip popovers (General
// Agent, specialist rows, Multiloop roles) and the Sprint Engine roster runtime
// pickers. Rendered as one shared flat list grouped by CLI with
// whitespace between groups: each group leads with a bare CLI row — that CLI
// with no `--model` flag, so it rides the CLI's own default — followed by one
// row per model. Every row carries the CLI brand icon. Picking any row selects
// the CLI and the model together in a single action; the bare row clears the
// model (CLIs without a model catalog select the CLI as-is).
export function CliModelListbox({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  options: CliModelListboxOption[]
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}) {
  return (
    <div role="listbox" aria-label={ariaLabel} className="max-h-[280px] overflow-y-auto">
      {options.map((option, groupIndex) => {
        const models = option.modelSelection
        const effectiveModel = option.value === currentCli ? effectiveModelFor(option.value) : undefined
        const hasStaleModel =
          Boolean(effectiveModel) && !models?.options.some((model) => model.id === effectiveModel)
        return (
          <div
            key={option.value}
            role="group"
            aria-label={option.label}
            className={groupIndex > 0 ? 'mt-1.5' : ''}
          >
            <CliModelRow
              icon={option.value}
              label={option.label}
              selected={option.value === currentCli && !effectiveModel}
              onClick={() => (models ? onSelectModel(option.value, null) : onSelectCli(option.value))}
            />
            {models?.options.map((model) => (
              <CliModelRow
                key={model.id}
                icon={option.value}
                label={model.label ?? model.id}
                mono={!model.label}
                selected={option.value === currentCli && effectiveModel === model.id}
                onClick={() => onSelectModel(option.value, model.id)}
              />
            ))}
            {/* A persisted model no longer in the catalog still launches with
                that id; surface it as the checked entry, marked "Not listed" so
                the user knows it is active but not one of the configured ids. */}
            {models && hasStaleModel && effectiveModel ? (
              <CliModelRow
                icon={option.value}
                label={effectiveModel}
                mono
                selected
                note="Not listed"
                onClick={() => onSelectModel(option.value, effectiveModel)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
