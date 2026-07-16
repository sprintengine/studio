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
  quiet,
  maxWidthClassName = 'max-w-[220px]',
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  options: CliModelListboxOption[]
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  disabled?: boolean
  /**
   * Opt-in low-emphasis trigger for in-place property editing (the Sprint
   * Engine roster's role bands): renders as plain muted text until hover or
   * focus reveal the control chrome. Default (undefined/false) keeps the
   * bordered form-control trigger unchanged for existing hosts.
   */
  quiet?: boolean
  /**
   * Trigger width clamp override. The default `max-w-[220px]` keeps the chip
   * compact in dense tables; pass `max-w-none` where the full "CLI · model"
   * label must never truncate (the sprint wizard's roster rows).
   */
  maxWidthClassName?: string
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
            className={
              quiet
                ? `
                  interactive group/pill inline-flex h-6 ${maxWidthClassName} items-center justify-between gap-1.5 rounded border border-transparent
                  px-1.5 text-left text-[11px] text-[color:var(--text-muted)] transition-colors
                  hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--text-default)]
                  focus:outline-none focus-visible:border-[color:var(--border-default)] focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]
                  disabled:cursor-not-allowed disabled:opacity-45
                `
                : `
                  interactive inline-flex h-7 min-w-[140px] ${maxWidthClassName} items-center justify-between gap-2 rounded-md border border-[color:var(--color-5)]
                  bg-[color:var(--bg-surface-raised)] px-2 text-left text-[12px] text-[color:var(--text-default)] transition-colors
                  hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  disabled:cursor-not-allowed disabled:opacity-45
                `
            }
            {...triggerProps}
          >
            <span className="flex min-w-0 items-center gap-2">
              <CliIcon cli={selected.value} className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-muted)]" />
              <span className="truncate">{triggerLabel}</span>
            </span>
            <span
              aria-hidden="true"
              className={`shrink-0 text-[10px] text-[color:var(--text-disabled)] ${
                quiet ? 'opacity-0 transition-opacity group-hover/pill:opacity-100 group-focus-visible/pill:opacity-100' : ''
              }`}
            >
              ▾
            </span>
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
// `indent` marks the row as a model nested under its CLI header: the label is
// indented to align under the header's label and the redundant repeated brand
// icon is dropped, so models read as children of the CLI rather than peer CLIs.
function CliModelRow({
  icon,
  label,
  selected,
  mono,
  note,
  indent,
  onClick,
}: {
  icon: AgentCli
  label: string
  selected: boolean
  mono?: boolean
  note?: string
  indent?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded py-1.5 pr-2 text-left text-[12px] transition-colors ${
        indent ? 'pl-8' : 'pl-2'
      } ${
        mono ? 'font-mono text-[11px]' : ''
      } ${
        selected
          ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {indent ? null : (
        <CliIcon cli={icon} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
      )}
      <TruncatedText as="span" text={label} className="min-w-0 flex-1" />
      {note ? (
        <span className="shrink-0 font-sans text-[10px] text-[color:var(--text-muted)]">{note}</span>
      ) : null}
      {selected ? <span className="shrink-0 text-[color:var(--accent-primary)]">✓</span> : null}
    </button>
  )
}

// Runtime listbox shared by the top-bar spawn-row chip popovers (General
// Agent, specialist rows, Multiloop roles) and the Sprint Engine roster runtime
// pickers. Grouped by CLI with whitespace between groups: each group leads with a
// branded CLI header row — that CLI with no `--model` flag, so it rides the CLI's
// own default — followed by one indented row per model. The header carries the
// CLI brand icon; the model rows are indented under it with the redundant icon
// dropped, so they read as children of the CLI rather than peer CLIs. Picking any
// row selects the CLI and the model together in a single action; the header row
// clears the model (CLIs without a model catalog select the CLI as-is).
export function CliModelListbox({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  onSelectCli,
  onSelectModel,
  className,
}: {
  ariaLabel: string
  options: CliModelListboxOption[]
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  /** Height clamp override — popovers keep the default; inline hosts may allow more. */
  className?: string
}) {
  return (
    <div role="listbox" aria-label={ariaLabel} className={`overflow-y-auto ${className ?? 'max-h-[280px]'}`}>
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
                indent
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
                indent
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
