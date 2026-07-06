import { useMemo, useRef, useState } from 'react'

import { GhostButton } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import {
  ModelCatalogHeaderRow,
  ModelCatalogRow,
  draftRowToEntry,
  entryToDraftRow,
  isCatalogCliUnavailable,
  type ModelCatalogDraftRow,
} from './modelCatalogRows'
import {
  filterCatalogByAvailability,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
} from '../workspace/newWorkspace/cliRuntimeOptions'
import { normalizeSprintEngineModelCatalog } from '../../utils/modelCatalog'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, SprintEngineModelCatalogEntry } from '../../types/workspace'

// Settings → Model catalog (plan Frame B). The user records facts about each
// CLI+model they use — 1–10 scores, a relative cost multiplier, a note, and an
// "offered by default" toggle — once, stable across sprints. Which of these a
// given sprint may use is the wizard's per-sprint checkbox (T4); this section
// only owns the facts. Entries whose CLI is not installed stay visible but are
// marked unavailable and auto-excluded everywhere by the T1 availability
// selector. Presentation + pure logic live in ./modelCatalogRows (store-free).

export function ModelCatalogSection() {
  const catalog = useWorkspaceStore((s) => s.appSettings.sprintEngineModelCatalog)
  const setCatalog = useWorkspaceStore((s) => s.setSprintEngineModelCatalog)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)

  // Full catalog (every configured CLI, with its merged model options) drives
  // model lookups; the availability-filtered slice is what the CLI picker may
  // offer, so a new row can only ever name an installed CLI.
  const fullCliCatalog = useMemo(
    () => selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes],
  )
  const installedCliOptions = useMemo(
    () => filterCatalogByAvailability(fullCliCatalog, cliAvailability, cliAvailabilityStatus),
    [fullCliCatalog, cliAvailability, cliAvailabilityStatus],
  )
  const cliOptionByValue = useMemo(() => {
    const map = new Map<AgentCli, AgentCliCatalogOption>()
    for (const option of fullCliCatalog) map.set(option.value, option)
    return map
  }, [fullCliCatalog])

  // Local edit buffer (see ModelCatalogDraftRow). Seeded once from the persisted
  // catalog; every edit persists through the setter below, and remounting the
  // tab (or reloading) re-seeds from the normalized store — so round-trip is
  // inherent and there is no second source of truth to keep in sync. The buffer
  // also lets "Add model" hold a not-yet-distinct row that the T1 normalizer
  // would otherwise dedupe away before the user can give it a distinct model.
  const keyRef = useRef(0)
  const [rows, setRows] = useState<ModelCatalogDraftRow[]>(() =>
    catalog.map((entry) => entryToDraftRow(entry, (keyRef.current += 1))),
  )

  const commit = (next: ModelCatalogDraftRow[]) => {
    setRows(next)
    setCatalog(next.map(draftRowToEntry))
  }

  const updateRow = (key: number, patch: Partial<ModelCatalogDraftRow>) => {
    commit(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  // On blur, snap a row's numeric/note cells to their normalized values so what
  // the user sees matches what is stored — coercion stays the normalizer's job.
  // The store already holds the normalized values (updateRow committed them), so
  // this only reconciles the display buffer.
  const reconcileRow = (key: number) => {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        const [normalized] = normalizeSprintEngineModelCatalog([draftRowToEntry(row)])
        if (!normalized) return row
        return { ...entryToDraftRow(normalized, row.key), cli: row.cli, model: row.model }
      }),
    )
  }

  const addRow = () => {
    const cli = installedCliOptions[0]?.value ?? fullCliCatalog[0]?.value ?? 'claude-code'
    const [blank] = normalizeSprintEngineModelCatalog([{ cli } satisfies Partial<SprintEngineModelCatalogEntry>])
    if (!blank) return
    commit([...rows, entryToDraftRow(blank, (keyRef.current += 1))])
  }

  const removeRow = (key: number) => {
    commit(rows.filter((row) => row.key !== key))
  }

  return (
    <section
      aria-labelledby="model-catalog-heading"
      className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5"
    >
      <SettingsSectionTitle
        id="model-catalog-heading"
        count={rows.length || undefined}
        action={
          <GhostButton
            size="md"
            onClick={addRow}
            className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Add model
          </GhostButton>
        }
      >
        Model catalog
      </SettingsSectionTitle>
      <p className="max-w-[640px] text-[12px] leading-5 text-[color:var(--text-muted)]">
        Facts about your models, entered once. Score each 1–10 on what it&apos;s good at; Cost is a
        relative multiplier (a 10× model costs ten times a 1× model); notes are free-text guidance.
        Each sprint picks which of these it may use —{' '}
        <b className="font-medium text-[color:var(--text-default)]">Default</b> just sets whether a
        model starts ticked. Rows whose CLI isn&apos;t installed are excluded automatically
        everywhere.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--border-default)] px-3 py-6 text-center text-[12px] text-[color:var(--text-muted)]">
          No models yet. Add the CLI + model pairings you use so the architect can pick from them.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[900px] overflow-hidden rounded-md border border-[color:var(--border-default)]">
            <ModelCatalogHeaderRow />
            <div className="divide-y divide-[color:var(--border-subtle)]">
              {rows.map((row) => (
                <ModelCatalogRow
                  key={row.key}
                  row={row}
                  cliOption={cliOptionByValue.get(row.cli)}
                  installedCliOptions={installedCliOptions}
                  unavailable={isCatalogCliUnavailable(row.cli, cliAvailability, cliAvailabilityStatus)}
                  onUpdate={(patch) => updateRow(row.key, patch)}
                  onReconcile={() => reconcileRow(row.key)}
                  onRemove={() => removeRow(row.key)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
