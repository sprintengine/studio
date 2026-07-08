import React from 'react'
import { SpecialistActionIcon } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import { CliModelListbox, Popover, TruncatedText } from '../../ui'
import { getSpecialistAction, type SpecialistAction } from '../../../specialists/specialistActions'
import type { AgentCli, SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { selectAgentCliCatalog } from '../newWorkspace/cliRuntimeOptions'
import { PermissionPresetChips, SpawnDebugToggle, TerminalSessionIcon } from './agentSpawnShared'
import {
  useAgentComposer,
  rowMatchesSelection,
  selectionForRow,
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'

export type { AgentComposerConfirm, AgentComposerSelection } from './useAgentComposer'

// One choosable project scope: a folder some open workspace lives in.
export type ComposerProjectOption = { path: string; label: string }

export type AgentComposerProps = {
  // Where the chat will be created — shown in the panel header as a scoping
  // chip that doubles as a project picker: the open projects plus Browse for a
  // folder Multicode doesn't know yet. The host owns the folder state.
  folderPath: string | null
  folderLabel: string | null
  projectOptions: ComposerProjectOption[]
  onSelectProject: (path: string) => void
  onBrowseProject: () => void
  // The remembered agent, preselected on open. Absent → first specialist.
  initialSelection: AgentComposerSelection
  // Shared permission preset (owned by the host so spawn handlers read it at
  // spawn time). Debug mode is transient and defaulted off per spawn.
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  // Confirm creates the chat (host maps to its spawn handlers); close discards.
  onConfirm: (confirm: AgentComposerConfirm) => void
  onClose: () => void
  // Hosted inside another panel (the New workspace door) that already owns the
  // title and Close. When true, the composer drops its own "New chat" title and
  // Close so the surface reads as one panel, not a panel-within-a-panel; the
  // project-scope chip stays as the config region's scoping control.
  embedded?: boolean
}

/**
 * The pre-creation agent composer (panel density). Two columns: the roster is
 * the primary decision (search + Terminal / General quick rows + the specialist
 * roster), the config column describes the selected agent and binds the engine
 * (CLI + model) to it. Nothing is created until the user confirms; the host's
 * onConfirm performs the actual spawn.
 *
 * The engine controls always reflect the selected agent's remembered CLI/model
 * and persist edits back as that agent's default, so browsing the roster never
 * corrupts a default and the choice the user sees is the choice that spawns.
 */
export default function AgentComposer({
  folderPath,
  folderLabel,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onConfirm,
  onClose,
  embedded = false,
}: AgentComposerProps) {
  const composer = useAgentComposer({
    mode: 'specialist',
    showTerminal: true,
    conversationAvailable: false,
    initialSelection,
  })
  const { selection, visibleRows } = composer
  const searchRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const commit = (target: AgentComposerSelection) => onConfirm(composer.buildConfirm(target))

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      composer.moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      composer.moveSelection(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(selection)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const activeSpecialist =
    selection.kind === 'specialist' ? getSpecialistAction(selection.specialistId) : null
  const optionId = (row: ComposerRow) => `agent-composer-option-${row.key}`
  const selectedRow = visibleRows.find((row) => rowMatchesSelection(row, selection))
  const quickRows = visibleRows.filter((row) => row.kind === 'terminal' || row.kind === 'general')
  const specialistRows = visibleRows.filter(
    (row): row is Extract<ComposerRow, { kind: 'specialist' }> => row.kind === 'specialist',
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[color:var(--bg-surface)]">
      <div className="flex items-center gap-3 border-b border-[color:var(--border-subtle)] px-4 py-2.5">
        {embedded ? null : (
          <span className="text-[13px] font-semibold text-[color:var(--text-strong)]">New chat</span>
        )}
        <ProjectScopeChip
          folderPath={folderPath}
          folderLabel={folderLabel}
          options={projectOptions}
          onSelectProject={onSelectProject}
          onBrowseProject={onBrowseProject}
        />
        {embedded ? null : (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded p-1 text-[color:var(--text-disabled)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[292px_1fr]">
        {/* Roster column — the primary decision. */}
        <div className="flex min-h-0 flex-col border-r border-[color:var(--border-subtle)] p-3">
          <div className="mb-2 flex items-center gap-2 rounded border border-[color:var(--border-subtle)] px-2.5 py-1.5">
            <svg className="icon-xs shrink-0 text-[color:var(--text-disabled)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              value={composer.query}
              onChange={(event) => composer.setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search agents"
              aria-label="Search agents"
              aria-controls="agent-composer-roster"
              aria-activedescendant={selectedRow ? optionId(selectedRow) : undefined}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] focus:outline-none"
            />
          </div>

          <div
            id="agent-composer-roster"
            role="listbox"
            aria-label="Agents"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {visibleRows.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] text-[color:var(--text-disabled)]">No matches</div>
            ) : (
              <>
                {quickRows.length > 0 ? (
                  <div className="pb-1">
                    {quickRows.map((row) => (
                      <ComposerRosterRow
                        key={row.key}
                        id={optionId(row)}
                        selected={rowMatchesSelection(row, selection)}
                        icon={
                          row.kind === 'terminal' ? (
                            <TerminalSessionIcon className="h-4 w-4" />
                          ) : (
                            // The General row wears its own bound CLI, never the
                            // highlighted row's — browsing must not repaint it.
                            <CliIcon cli={composer.cliForSelection({ kind: 'general' })} className="h-4 w-4" />
                          )
                        }
                        label={row.kind === 'terminal' ? 'Terminal' : 'General agent'}
                        onSelect={() => composer.setSelection(selectionForRow(row))}
                        onConfirm={() => commit(selectionForRow(row))}
                      />
                    ))}
                  </div>
                ) : null}

                {specialistRows.length > 0 ? (
                  <div className="border-t border-[color:var(--border-subtle)] pt-1">
                    <div className="px-2 pb-1 pt-1 text-[10.5px] text-[color:var(--text-subtle)]">Specialists</div>
                    {specialistRows.map((row) => (
                      <ComposerRosterRow
                        key={row.key}
                        id={optionId(row)}
                        selected={rowMatchesSelection(row, selection)}
                        icon={<SpecialistActionIcon icon={row.action.icon} className="h-4 w-4" />}
                        label={row.action.shortLabel}
                        onSelect={() => composer.setSelection(selectionForRow(row))}
                        onConfirm={() => commit(selectionForRow(row))}
                      />
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* Config column — the selected agent and its engine. */}
        <div className="flex min-h-0 flex-col p-5">
          <ComposerConfig
            selection={selection}
            activeSpecialist={activeSpecialist}
            selectionCli={composer.selectionCli}
            agentCliOptions={composer.agentCliOptions}
            generalCliOptions={composer.generalCliOptions}
            modelFor={(cli) => composer.modelForSelection(selection, cli)}
            onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
            onSelectModel={(cli, model) => composer.setEngineModel(selection, cli, model)}
            permissionPreset={permissionPreset}
            onChangePermissionPreset={onChangePermissionPreset}
            debugMode={debugMode}
            onChangeDebugMode={onChangeDebugMode}
          />

          <div className="mt-auto flex items-center gap-3 pt-5">
            <button
              type="button"
              onClick={() => commit(selection)}
              className="inline-flex items-center gap-2 rounded-md bg-[color:var(--accent-primary)] px-4 py-1.5 text-[13px] font-semibold text-[color:var(--text-on-accent)] transition-colors hover:bg-[color:var(--accent-primary-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
            >
              {selection.kind === 'terminal' ? 'Open terminal' : 'Start chat'}
              <kbd className="rounded bg-black/15 px-1 font-mono text-[11px]">⏎</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 4.5C2 3.7 2.7 3 3.5 3H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

// The header's project scope: a chip naming the folder the chat will land in,
// opening a picker over the projects already open in Multicode plus Browse…
// for a folder Multicode doesn't know yet. Selection reports up — the host
// owns the folder state the confirm reads.
function ProjectScopeChip({
  folderPath,
  folderLabel,
  options,
  onSelectProject,
  onBrowseProject,
}: {
  folderPath: string | null
  folderLabel: string | null
  options: ComposerProjectOption[]
  onSelectProject: (path: string) => void
  onBrowseProject: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const currentKey = folderPath ? normalizeProjectPath(folderPath) : null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Project for this chat"
      popupRole="menu"
      placement="bottom-start"
      className="min-w-0"
      surfaceClassName="w-[300px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="inline-flex min-w-0 items-center gap-1.5 rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-default)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]"
          {...triggerProps}
        >
          <FolderGlyph className="icon-xs shrink-0" />
          <span className="truncate">{folderLabel ?? 'Choose project'}</span>
          <span aria-hidden="true" className="shrink-0 text-[10px] text-[color:var(--text-disabled)]">▾</span>
        </button>
      )}
    >
      {options.map((option) => {
        const current = currentKey !== null && normalizeProjectPath(option.path) === currentKey
        return (
          <button
            key={option.path}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            onClick={() => {
              onSelectProject(option.path)
              setOpen(false)
            }}
            className="grid w-full grid-cols-[16px_1fr_auto] items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
          >
            <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
            <span className="min-w-0">
              <span className="block truncate text-[12px] text-[color:var(--text-default)]">{option.label}</span>
              <span className="block truncate font-mono text-[10.5px] text-[color:var(--text-subtle)]">{option.path}</span>
            </span>
            {current ? (
              <svg className="icon-sm shrink-0 text-[color:var(--accent-primary)]" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2 5.2l2 2 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <span aria-hidden="true" />
            )}
          </button>
        )
      })}
      {options.length > 0 ? <div className="my-1 h-px bg-[color:var(--border-subtle)]" role="separator" /> : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          setOpen(false)
          onBrowseProject()
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        <svg className="icon-xs shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Browse…
      </button>
    </Popover>
  )
}

// A roster option. Selection is the durable state (aria-selected + the accent
// inset bar, reusing the SpawnAgentMenu highlight idiom); double-click confirms.
// The last-used agent needs no separate marker — it is the selected row on open.
function ComposerRosterRow({
  id,
  selected,
  icon,
  label,
  onSelect,
  onConfirm,
}: {
  id: string
  selected: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  onConfirm: () => void
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      onDoubleClick={onConfirm}
      className={`grid w-full grid-cols-[20px_1fr] items-center gap-2 py-1.5 pr-2 text-left transition-colors ${
        selected
          ? 'bg-[color:var(--accent-primary-soft)] pl-[7px] text-[color:var(--text-strong)] shadow-[inset_3px_0_0_var(--accent-primary)]'
          : 'pl-2.5 text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      <span className={selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'}>
        {icon}
      </span>
      <TruncatedText as="span" text={label} className="text-[13px]" />
    </button>
  )
}

function ComposerConfig({
  selection,
  activeSpecialist,
  selectionCli,
  agentCliOptions,
  generalCliOptions,
  modelFor,
  onSelectCli,
  onSelectModel,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
}: {
  selection: AgentComposerSelection
  activeSpecialist: SpecialistAction | null
  selectionCli: AgentCli
  agentCliOptions: ReturnType<typeof selectAgentCliCatalog>
  generalCliOptions: ReturnType<typeof selectAgentCliCatalog>
  modelFor: (cli: AgentCli) => string | undefined
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
}) {
  if (selection.kind === 'terminal') {
    return (
      <div>
        <div className="flex items-center gap-2.5">
          <TerminalSessionIcon className="h-[18px] w-[18px] text-[color:var(--text-strong)]" />
          <span className="text-[15px] font-semibold text-[color:var(--text-strong)]">Terminal</span>
        </div>
        <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-[color:var(--text-muted)]">
          A plain shell in this project's folder — no agent, no model.
        </p>
      </div>
    )
  }

  const isSpecialist = selection.kind === 'specialist' && activeSpecialist !== null
  const name = isSpecialist ? activeSpecialist!.shortLabel : 'General agent'
  const description = isSpecialist
    ? activeSpecialist!.description
    : 'A general-purpose agent with no role prompt — it runs your instructions as written.'
  const icon = isSpecialist ? (
    <SpecialistActionIcon icon={activeSpecialist!.icon} className="h-[18px] w-[18px] text-[color:var(--text-strong)]" />
  ) : (
    <CliIcon cli={selectionCli} className="h-[18px] w-[18px] text-[color:var(--text-strong)]" />
  )

  return (
    <div className="min-h-0">
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="text-[15px] font-semibold text-[color:var(--text-strong)]">{name}</span>
      </div>
      <p className="mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-[color:var(--text-muted)]">{description}</p>

      {/* Inline engine list: each CLI vertically, its models indented beneath.
          One click picks CLI + model together and persists as this agent's
          remembered default — same grouping as the popover's chip flyout, just
          always visible. */}
      <div className="mt-5 max-w-[340px]">
        <CliModelListbox
          ariaLabel={`Agent runtime for ${name}`}
          options={isSpecialist ? agentCliOptions : generalCliOptions}
          currentCli={selectionCli}
          effectiveModelFor={modelFor}
          onSelectCli={onSelectCli}
          onSelectModel={onSelectModel}
          className="max-h-[44vh]"
        />
      </div>

      <div className="mt-5 border-t border-[color:var(--border-subtle)] pt-3">
        <div className="flex flex-wrap items-center gap-1">
          <PermissionPresetChips value={permissionPreset} onChange={onChangePermissionPreset} />
          <SpawnDebugToggle active={debugMode} onChange={onChangeDebugMode} />
        </div>
      </div>
    </div>
  )
}
