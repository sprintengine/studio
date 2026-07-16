import React from 'react'

import { CliModelPickerButton } from '../../ui'
import { modelCatalogEntryKey } from '../../../utils/modelCatalog'
import { labelForCliRuntime } from './cliRuntimeOptions'
import type { SprintEngineCliOption } from './SprintEngineRosterTable'
import type { SprintEngineAllowedRuntime, SprintEngineModelCatalogEntry } from '../../../types/workspace'

// "Architect picks the team" card (mockup Frame A). Three parts: the user-pinned
// architect seat runtime, the per-sprint model selection (the ticked set becomes
// the run's allowedRuntimes and the architect's palette), and the optional
// prompt-only guidance line. The architect seat is independent of the ticked set
// on purpose — pinning it to a model left unticked expresses "this model runs the
// architect and nowhere else". Kept separate from SprintEngineRosterTable because
// the two modes model different things: a hand-picked roster vs. a model palette.
export function ArchitectTeamCard({
  seat,
  seatDefaultedFromCatalog,
  cliOptions,
  onChangeSeat,
  availableEntries,
  selectedKeys,
  onToggleEntry,
  guidance,
  onChangeGuidance,
}: {
  seat: SprintEngineAllowedRuntime
  // True when the seat was defaulted to the catalog's highest-Intelligence entry
  // (vs. the plain wizard CLI default), so the hint can say where it came from.
  seatDefaultedFromCatalog: boolean
  cliOptions: SprintEngineCliOption[]
  onChangeSeat: (seat: SprintEngineAllowedRuntime) => void
  availableEntries: SprintEngineModelCatalogEntry[]
  selectedKeys: ReadonlySet<string>
  onToggleEntry: (entry: SprintEngineAllowedRuntime) => void
  guidance: string
  onChangeGuidance: (value: string) => void
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)]">
      <ArchRow label="Architect runs on" hint={seatDefaultedFromCatalog ? 'defaulted from your catalog’s highest Intelligence score' : 'runs this planning session'}>
        <CliModelPickerButton
          ariaLabel="Architect runtime"
          options={cliOptions}
          cli={seat.cli}
          effectiveModelFor={(candidateCli) => (candidateCli === seat.cli ? seat.model ?? undefined : undefined)}
          onSelectCli={(nextCli) => onChangeSeat({ cli: nextCli, model: null })}
          onSelectModel={(nextCli, nextModel) => onChangeSeat({ cli: nextCli, model: nextModel })}
        />
      </ArchRow>

      <ArchRow label="Models for this sprint" hint="scores live in Settings" align="start">
        <fieldset className="flex min-w-0 flex-1 flex-col gap-1.5 border-0 p-0">
          <legend className="sr-only">Models the architect may assign for this sprint</legend>
          {availableEntries.length === 0 ? (
            // Guards the rare mid-session case where the catalog empties or every
            // CLI flips uninstalled while architect mode is already selected: the
            // row explains the block in-place instead of rendering blank.
            <p className="text-[11px] leading-4 text-[color:var(--text-muted)]">
              No models available — add one to your catalog in Settings.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {availableEntries.map((entry) => {
              const key = modelCatalogEntryKey(entry.cli, entry.model)
              const checked = selectedKeys.has(key)
              const modelLabel = entry.model ?? 'CLI default'
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => onToggleEntry({ cli: entry.cli, model: entry.model })}
                  className={`
                    inline-flex items-center gap-2 rounded-md border px-2 py-1 text-left transition-colors
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)]
                    ${checked
                      ? 'border-[color:var(--accent-primary-soft)] bg-[color:var(--accent-primary-soft)]'
                      : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] hover:border-[color:var(--border-strong)]'}
                  `}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[8px] ${
                      checked
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--bg-app)]'
                        : 'border-[color:var(--border-strong)] text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-[11px] text-[color:var(--text-subtle)]">{labelForCliRuntime(entry.cli)}</span>
                    <span className="font-mono text-[11px] text-[color:var(--text-default)]">{modelLabel}</span>
                    <span className="text-[10px] tabular-nums text-[color:var(--text-subtle)]">intel {entry.intelligence}</span>
                    {/* Cost is neutral, not a warning: matches the Settings catalog
                        (modelCatalogRows.tsx) and never grades the cheapest model as flagged. */}
                    <span className="text-[10px] tabular-nums text-[color:var(--text-subtle)]">{entry.cost}×</span>
                  </span>
                </button>
              )
            })}
          </div>
        </fieldset>
      </ArchRow>

      <ArchRow label="Guidance for the architect" hint="optional">
        <input
          type="text"
          value={guidance}
          placeholder="e.g. Quality matters — don’t skimp on reviews."
          aria-label="Guidance for the architect"
          onChange={(event) => onChangeGuidance(event.target.value)}
          className="
            h-7 min-w-0 flex-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]
            px-2.5 text-[12px] text-[color:var(--text-default)] outline-none transition-colors
            focus:border-[color:var(--accent-primary)]
          "
        />
      </ArchRow>

      <div className="flex items-start gap-2.5 px-3.5 py-3 text-[11px] leading-4 text-[color:var(--text-muted)]">
        <span className="font-medium text-[color:var(--text-default)]">Team is approved with the plan.</span>
        <span>Only ticked models can be assigned — the engine rejects anything else.</span>
      </div>
    </div>
  )
}

function ArchRow({
  label,
  hint,
  align = 'center',
  children,
}: {
  label: string
  hint: string
  align?: 'center' | 'start'
  children: React.ReactNode
}) {
  return (
    <div className={`flex gap-3 border-b border-[color:var(--border-subtle)] px-3.5 py-3 last:border-b-0 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <span className={`w-[132px] shrink-0 text-[12px] font-medium text-[color:var(--text-default)] ${align === 'start' ? 'pt-1' : ''}`}>
        {label}
      </span>
      {children}
      <span className={`ml-auto shrink-0 text-[11px] text-[color:var(--text-subtle)] ${align === 'start' ? 'pt-1' : ''}`}>{hint}</span>
    </div>
  )
}
