import React from 'react'
import { CheckIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import { TruncatedText } from './TruncatedText'
import { ReasoningLevelPicker } from '../workspace/agentComposer/agentSpawnShared'
import type { AgentCli } from '../../types/workspace'
import type { PluginModelCatalog, PluginReasoningCatalog } from '../../../../shared/plugin-manifest'

// Structurally compatible with AgentCliCatalogOption from
// newWorkspace/cliRuntimeOptions; declared here so the ui primitive does not
// import from a workspace module.
export type CliModelListboxOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  hostedVia?: 'claude-code'
}

// Compact "CLI · model" trigger button wrapping CliModelListbox in a popover.
// Shared by the Sprint Engine roster runtime pickers (new-workspace roster
// rows, board add-member dialog). Selecting a CLI or model closes the popover.
export function CliModelPickerButton({
  ariaLabel,
  options,
  cli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
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
  /**
   * Opt-in reasoning-effort support (manifest reasoningSelection). When both
   * accessors are provided, the listbox renders a level segmented control under
   * the selected entry and the trigger suffixes a non-default level. Hosts
   * without effort persistence omit them and render exactly as before.
   */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
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
  // Hosted models (zai, kimi-claude) name the host in the trigger — "Kimi K3 ·
  // Claude Code" — since their own label is the model, not a CLI. A reasoning
  // level away from the CLI's default trails last, muted: "Codex · GPT · high".
  const reasoning = effectiveReasoningFor?.(cli)
  const reasoningSuffix =
    reasoning && selected.reasoningSelection && reasoning !== selected.reasoningSelection.default
      ? ` · ${reasoning}`
      : ''
  const baseLabel = modelLabel
    ? `${selected.label} · ${modelLabel}`
    : selected.hostedVia === 'claude-code'
      ? `${selected.label} · Claude Code`
      : selected.label
  const triggerLabel = `${baseLabel}${reasoningSuffix}`
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
                  px-1.5 text-left text-[11px] text-[color:var(--text-muted)]
                  hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--text-default)]
                  focus:outline-none focus-visible:border-[color:var(--border-default)] focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
                  disabled:cursor-not-allowed disabled:opacity-45
                `
                : `
                  interactive inline-flex h-7 min-w-[140px] ${maxWidthClassName} items-center justify-between gap-2 rounded-md border border-[color:var(--color-5)]
                  bg-[color:var(--bg-surface-raised)] px-2 text-left text-[12px] text-[color:var(--text-default)]
                  hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]
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
              className={`shrink-0 text-micro text-[color:var(--text-disabled)] ${
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
        effectiveReasoningFor={effectiveReasoningFor}
        onSelectReasoning={onSelectReasoning}
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

// A model's raw id, shown beside its friendly label only when it adds
// information the label does not already carry — `opus[1m]` beside "Opus"
// stays, `gpt-5.5` beside "GPT-5.5" goes. The test is one-directional: the id
// is dropped when the LABEL already spells out everything the id says, ignoring
// case and separators. It is kept whenever the id carries something the name
// does not, because that something (a context-window variant, a vendor
// namespace) is exactly what a person needs to tell two rows apart.
export function meaningfulModelId(id: string, label: string | undefined): string | undefined {
  if (!label) return undefined // the row already renders the bare id in the mono face
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const normalizedId = normalize(id)
  const normalizedLabel = normalize(label)
  if (!normalizedId || !normalizedLabel) return undefined
  return normalizedLabel.includes(normalizedId) ? undefined : id
}

const CLI_MODEL_ROW_SELECTOR = '[data-cli-model-row="true"]'

// One selectable runtime row: CLI brand icon + label, with a check when active.
// `mono` renders raw model ids (no friendly label) in the mono face. `monoId` is
// the trailing raw id beside a friendly label (see meaningfulModelId). `note` is
// a muted trailing annotation — used to flag a persisted model id that is no
// longer in the CLI's model list, so it reads as deliberate rather than a normal
// choice. `indent` marks the row as a model nested under its CLI header: the
// label is indented to align under the header's label and the redundant repeated
// brand icon is dropped, so models read as children of the CLI rather than peer
// CLIs. `picker` is the inline reasoning-effort control, rendered on the
// selected row only.
//
// The row is a `div[role=option]` rather than a `<button>` because it hosts the
// picker's own button, and a button inside a button is invalid. Selection keeps
// full keyboard operation: the row is a tab stop with Enter/Space selecting,
// arrows roving between rows (handled by the listbox), and ArrowRight reaching
// the picker.
function CliModelRow({
  icon,
  label,
  selected,
  tabbable,
  mono,
  monoId,
  note,
  indent,
  picker,
  onClick,
}: {
  icon: AgentCli
  label: string
  selected: boolean
  tabbable: boolean
  mono?: boolean
  monoId?: string
  note?: string
  indent?: boolean
  picker?: React.ReactNode
  onClick: () => void
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      data-cli-model-row="true"
      tabIndex={tabbable ? 0 : -1}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      // Never wraps and never grows: the label is the only flexible cell, every
      // trailing cell is shrink-0, so the row stays exactly one line tall
      // whatever combination of id, note, picker and check it carries.
      className={`interactive flex w-full cursor-pointer items-center gap-2 rounded py-1.5 pr-2 text-left text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
        indent ? 'pl-8' : 'pl-2'
      } ${
        mono ? 'font-mono text-[11px]' : ''
      } ${
        selected
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      {indent ? null : (
        <CliIcon cli={icon} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
      )}
      <TruncatedText as="span" text={label} className="min-w-0 flex-1" />
      {monoId ? (
        <span className="shrink-0 whitespace-nowrap font-mono text-micro text-[color:var(--text-subtle)]">
          {monoId}
        </span>
      ) : null}
      {note ? (
        <span className="shrink-0 whitespace-nowrap font-sans text-micro text-[color:var(--text-muted)]">{note}</span>
      ) : null}
      {picker ?? null}
      {/* The row already announces itself through aria-selected, so the mark is
          hidden. It inherits the selected row's --text-strong rather than the
          accent: selection is neutral. */}
      {selected ? <CheckIcon className="icon-xs shrink-0" /> : null}
    </div>
  )
}

// Runtime listbox shared by the top-bar spawn-row chip popovers (General
// Agent, specialist rows) and the Sprint Engine roster runtime
// pickers. Grouped by CLI with whitespace between groups: each group leads with a
// branded CLI header row — that CLI with no `--model` flag, so it rides the CLI's
// own default — followed by one indented row per model. The header carries the
// CLI brand icon; the model rows are indented under it with the redundant icon
// dropped, so they read as children of the CLI rather than peer CLIs. Picking any
// row selects the CLI and the model together in a single action; the header row
// clears the model (CLIs without a model catalog select the CLI as-is).
//
// Hosted models (manifest-derived `hostedVia`, e.g. Kimi K3 and Z.AI GLM riding
// the claude binary) render below the CLI groups under a labelled "Models via
// Claude Code" section: the section label explains the hosting once, so each
// row keeps its provider's own mark and name and reads as a model, not a peer
// CLI.
export function CliModelListbox({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
  onSelectCli,
  onSelectModel,
  className,
}: {
  ariaLabel: string
  options: CliModelListboxOption[]
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  /** Opt-in effort support — see CliModelPickerButton. Both must be set. */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  /** Height clamp override — popovers keep the default; inline hosts may allow more. */
  className?: string
}) {
  const cliOptions = options.filter((option) => !option.hostedVia)
  const hostedOptions = options.filter((option) => option.hostedVia)
  // Roving tab stop: the checked row owns it, so Tab lands on the current
  // choice and arrows move from there. With nothing checked anywhere, the very
  // first row takes it so the list is still reachable by keyboard.
  const hasSelection = options.some((option) => option.value === currentCli)
  let rowIndex = -1
  const nextTabbable = (selected: boolean): boolean => {
    rowIndex += 1
    return selected || (!hasSelection && rowIndex === 0)
  }

  // Arrows rove between rows across every group. Events from the effort
  // picker's trigger stop there, and its menu is portaled to <body>, so neither
  // reaches this handler.
  const onListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight') return
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(CLI_MODEL_ROW_SELECTOR)
    if (!row) return
    if (event.key === 'ArrowRight') {
      const picker = row.querySelector<HTMLButtonElement>('[data-reasoning-picker="true"]')
      if (!picker) return
      event.preventDefault()
      picker.focus()
      return
    }
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(CLI_MODEL_ROW_SELECTOR))
    const index = rows.indexOf(row)
    if (index < 0 || rows.length === 0) return
    event.preventDefault()
    rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
  }

  const renderGroup = (option: CliModelListboxOption, groupIndex: number) => {
    const models = option.modelSelection
    const effectiveModel = option.value === currentCli ? effectiveModelFor(option.value) : undefined
    const hasStaleModel =
      Boolean(effectiveModel) && !models?.options.some((model) => model.id === effectiveModel)
    // Effort is opt-in on BOTH accessors and on the CLI declaring levels: a host
    // that wires neither, or a CLI with no reasoningSelection, renders no picker
    // at all — never a greyed one, never an empty menu.
    const reasoningLevels =
      option.value === currentCli && option.reasoningSelection && effectiveReasoningFor && onSelectReasoning
        ? option.reasoningSelection.levels
        : undefined
    // One picker instance per rendered row: it belongs to the selected row's
    // right edge, and only one row of a group is ever selected.
    const renderPicker = (): React.ReactNode =>
      reasoningLevels ? (
        <ReasoningLevelPicker
          levels={reasoningLevels}
          value={effectiveReasoningFor!(option.value)}
          onSelect={(reasoning) => onSelectReasoning!(option.value, reasoning)}
        />
      ) : null

    const headerSelected = option.value === currentCli && !effectiveModel
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
          selected={headerSelected}
          tabbable={nextTabbable(headerSelected)}
          picker={headerSelected ? renderPicker() : null}
          onClick={() => (models ? onSelectModel(option.value, null) : onSelectCli(option.value))}
        />
        {models?.options.map((model) => {
          const modelSelected = option.value === currentCli && effectiveModel === model.id
          return (
            <CliModelRow
              key={model.id}
              icon={option.value}
              label={model.label ?? model.id}
              mono={!model.label}
              monoId={meaningfulModelId(model.id, model.label)}
              indent
              selected={modelSelected}
              tabbable={nextTabbable(modelSelected)}
              picker={modelSelected ? renderPicker() : null}
              onClick={() => onSelectModel(option.value, model.id)}
            />
          )
        })}
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
            tabbable={nextTabbable(true)}
            note="Not listed"
            picker={renderPicker()}
            onClick={() => onSelectModel(option.value, effectiveModel)}
          />
        ) : null}
      </div>
    )
  }
  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      onKeyDown={onListboxKeyDown}
      className={`overflow-y-auto ${className ?? 'max-h-[280px]'}`}
    >
      {cliOptions.map(renderGroup)}
      {hostedOptions.length > 0 ? (
        <>
          <div aria-hidden="true" className="mx-1 my-1.5 h-px bg-[color:var(--border-subtle)]" />
          <div className="px-2 pb-0.5 pt-1 text-micro font-semibold text-[color:var(--text-subtle)]">
            Models via Claude Code
          </div>
          {hostedOptions.map((option, index) => renderGroup(option, index))}
        </>
      ) : null}
    </div>
  )
}
