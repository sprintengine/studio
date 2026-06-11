import React from 'react'
import CliIcon from '../CliIcon'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
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

// CLI listbox shared by the top-bar spawn-row chip popovers (General Agent,
// specialist rows, Multiloop roles) and the Sprint Engine roster runtime
// pickers. Each CLI row selects that CLI as-is; rows whose plugin declares
// modelSelection get a trailing disclosure that expands an indented model
// list — "Default" (the CLI's own default, no flag passed), the merged seed +
// user-added options, and a free-text id when the plugin allows custom ids.
// Picking a model selects the CLI and the model together.
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
  const [expandedCli, setExpandedCli] = React.useState<AgentCli | null>(null)
  const [customModel, setCustomModel] = React.useState('')
  return (
    <div role="listbox" aria-label={ariaLabel}>
      {options.map((option) => {
        const isCurrent = option.value === currentCli
        const models = option.modelSelection
        const expanded = expandedCli === option.value
        const effectiveModel = effectiveModelFor(option.value)
        return (
          <React.Fragment key={option.value}>
            <div className="relative">
              <button
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => onSelectCli(option.value)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                  models ? 'pr-7' : ''
                } ${
                  isCurrent
                    ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                }`}
              >
                <CliIcon cli={option.value} className="icon-sm" />
                {option.label}
                {isCurrent ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
              </button>
              {models ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`Models for ${option.label}`}
                  onClick={() => {
                    setCustomModel('')
                    setExpandedCli((current) => (current === option.value ? null : option.value))
                  }}
                  className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[color:var(--text-disabled)] transition-colors hover:text-[color:var(--text-strong)]"
                >
                  <svg className={`icon-xs transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
            </div>
            {expanded && models ? (
              <div
                role="listbox"
                aria-label={`Model for ${option.label}`}
                // Bounded: the chip popover measured its flip placement before
                // this section expanded, so long model lists scroll instead of
                // growing past the spawn menu's clip.
                className="my-0.5 ml-3.5 max-h-[168px] overflow-y-auto border-l border-[color:var(--border-subtle)] pl-1"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={!effectiveModel}
                  onClick={() => onSelectModel(option.value, null)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                    !effectiveModel
                      ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                  }`}
                >
                  Default
                  {!effectiveModel ? <span className="ml-auto text-[color:var(--accent-primary)]">✓</span> : null}
                </button>
                {models.options.map((model) => {
                  const isModelCurrent = model.id === effectiveModel
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={isModelCurrent}
                      onClick={() => onSelectModel(option.value, model.id)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
                        model.label ? '' : 'font-mono text-[11px]'
                      } ${
                        isModelCurrent
                          ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-default)] hover:bg-[rgba(92,124,255,0.06)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{model.label ?? model.id}</span>
                      {isModelCurrent ? <span className="text-[color:var(--accent-primary)]">✓</span> : null}
                    </button>
                  )
                })}
                {/* A persisted model no longer in the catalog still launches with
                    that id; surface it as the checked entry instead of hiding it. */}
                {effectiveModel && !models.options.some((model) => model.id === effectiveModel) ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected
                    onClick={() => onSelectModel(option.value, effectiveModel)}
                    className="flex w-full items-center gap-2 rounded bg-[color:var(--accent-primary-soft-strong)] px-2 py-1 text-left font-mono text-[11px] text-[color:var(--text-strong)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{effectiveModel}</span>
                    <span className="text-[color:var(--accent-primary)]">✓</span>
                  </button>
                ) : null}
                {models.allowCustomId ? (
                  <input
                    type="text"
                    value={customModel}
                    placeholder="Custom model id"
                    aria-label={`Custom model id for ${option.label}`}
                    onChange={(event) => setCustomModel(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        const model = customModel.trim()
                        if (model) onSelectModel(option.value, model)
                      }
                    }}
                    className="mt-0.5 w-full rounded border border-[color:var(--border-subtle)] bg-transparent px-2 py-1 font-mono text-[11px] text-[color:var(--text-default)] placeholder:font-sans placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] focus:outline-none"
                  />
                ) : null}
              </div>
            ) : null}
          </React.Fragment>
        )
      })}
    </div>
  )
}
