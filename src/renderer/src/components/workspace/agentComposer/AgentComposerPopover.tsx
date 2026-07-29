import React from 'react'
import { SpecialistActionIcon } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import { CliModelListbox, FOCUS_RING_CLASS, SkillPickerPopover, StarGlyph, Tooltip, TruncatedText } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli, SpecialistActionId, SprintEngineCliPermissionPreset } from '../../../types/workspace'
import {
  ConversationProviderIcon,
  PermissionPresetChips,
  SpawnDebugToggle,
  TerminalSessionIcon,
} from './agentSpawnShared'
import {
  useAgentComposer,
  rowMatchesSelection,
  selectionForRow,
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'

// Spawn mode: clicking a row launches that agent into the active workspace and
// closes the picker — one click, like the split-button's primary half.
type SpawnAction = {
  kind: 'spawn'
  onSpawn: (confirm: AgentComposerConfirm) => void
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
}

// Select mode: clicking a row persists a choice (the Automations agent block)
// instead of spawning. The engine is owned externally, so the roster only
// reports the chosen soul; no terminal row, no engine chips, no debug toggle.
type SelectAction = {
  kind: 'select'
  selectedSpecialistId: SpecialistActionId | null
  cli: AgentCli
  model: string | undefined
  onSelectSpecialist: (id: SpecialistActionId, cli: AgentCli, model: string | undefined) => void
  onSelectGeneral: (cli: AgentCli, model: string | undefined) => void
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
}

export type AgentComposerPopoverProps = {
  // Whether the Conversation quick row is offered (spawn mode only).
  conversationAvailable: boolean
  // The remembered agent, preselected on open.
  initialSelection: AgentComposerSelection
  action: SpawnAction | SelectAction
  onClose: () => void
}

/**
 * The compact agent picker — the popover-density sibling of the New Chat panel,
 * sharing its roster/selection/engine model (`useAgentComposer`). Rendered by
 * every anchored picker surface: the top bar (spawn into the active workspace),
 * the empty-workspace launcher, and the Automations editor (select a soul, not
 * spawn). The caller supplies the floating surface; this renders the body only.
 *
 * Interaction contract (matches the retired SpawnAgentMenu): a row click acts
 * immediately — spawn or select — and closes. The engine (CLI/model) is a
 * per-row chip opening a nested flyout; editing it persists that agent's
 * default without spawning and without moving any other row's chrome.
 */
export default function AgentComposerPopover({
  conversationAvailable,
  initialSelection,
  action,
  onClose,
}: AgentComposerPopoverProps) {
  const selectMode = action.kind === 'select'
  const composer = useAgentComposer({
    // Select mode chooses a soul, not a runtime session — no terminal row.
    showTerminal: !selectMode,
    conversationAvailable: !selectMode && conversationAvailable,
    initialSelection,
  })
  const { selection, visibleRows } = composer
  const searchRef = React.useRef<HTMLInputElement>(null)
  // Which row's engine flyout is open (row key). One at a time across the menu.
  const [engineFlyoutRowKey, setEngineFlyoutRowKey] = React.useState<string | null>(null)
  // "+ Skill" attachment (spawn mode): ensure-installed at spawn with the
  // invocation prefilled as the agent's first input.
  const [skillPickerOpen, setSkillPickerOpen] = React.useState(false)
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const skillAttachAvailable = !selectMode && Boolean(activeWorkspaceRoot)
  // "+ Worktree" is only offered when the active workspace folder is inside a
  // git repository — probed once per open so a non-repo folder never shows a
  // control whose spawn would fail.
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    if (selectMode || !activeWorkspaceRoot) {
      setWorkspaceIsGitRepo(false)
      return
    }
    void window.api
      .getGitRepoRoot(activeWorkspaceRoot)
      .then((root) => {
        if (!cancelled) setWorkspaceIsGitRepo(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectMode, activeWorkspaceRoot])
  const worktreeAttachAvailable = !selectMode && workspaceIsGitRepo

  React.useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // The engine flyout lives inside the roster's scroll container, which clips
  // overflow. The picker surface is portaled to <body>, so position the open
  // flyout `fixed` by writing coordinates onto its node: it escapes the clip
  // and floats anchored to its row, flipping above when it would run past the
  // bottom. (Same approach as the retired SpawnAgentMenu — keeping the flyout a
  // DOM descendant of the surface means the surrounding Popover's outside-click
  // dismissal never mistakes a flyout click for an outside click.)
  React.useLayoutEffect(() => {
    if (!engineFlyoutRowKey) return
    const apply = () => {
      const surface = document.querySelector<HTMLElement>('[data-chip-popover="true"]')
      const anchor = surface?.parentElement
      if (!surface || !anchor) return
      const rect = anchor.getBoundingClientRect()
      const openUp = window.innerHeight - rect.top - 32 < surface.offsetHeight + 8
      surface.style.position = 'fixed'
      surface.style.left = 'auto'
      surface.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right + 8))}px`
      if (openUp) {
        surface.style.top = 'auto'
        surface.style.bottom = `${Math.round(window.innerHeight - rect.bottom + 32)}px`
      } else {
        surface.style.bottom = 'auto'
        surface.style.top = `${Math.round(rect.top + 32)}px`
      }
    }
    apply()
    window.addEventListener('resize', apply)
    window.addEventListener('scroll', apply, true)
    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener('scroll', apply, true)
    }
  }, [engineFlyoutRowKey])

  const commit = React.useCallback(
    (target: AgentComposerSelection) => {
      if (action.kind === 'select') {
        if (target.kind === 'specialist') {
          action.onSelectSpecialist(target.specialistId, action.cli, action.model)
        } else if (target.kind === 'general') {
          action.onSelectGeneral(action.cli, action.model)
        }
        onClose()
        return
      }
      action.onSpawn(composer.buildConfirm(target))
      onClose()
    },
    [action, composer, onClose],
  )

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
      if (engineFlyoutRowKey) {
        setEngineFlyoutRowKey(null)
      } else {
        onClose()
      }
    }
  }

  const optionId = (row: ComposerRow) => `agent-composer-pop-option-${row.key}`
  const selectedRow = visibleRows.find((row) => rowMatchesSelection(row, selection))

  // "Claude Code · Fable 5" for a row's remembered engine, for chip tooltips.
  const engineLabel = (target: AgentComposerSelection): string => {
    const cli = composer.cliForSelection(target)
    const option = composer.agentCliOptions.find((entry) => entry.value === cli)
    const cliLabel = option?.label ?? cli
    const model = composer.modelForSelection(target, cli)
    if (!model) return cliLabel
    const modelLabel = option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
    return `${cliLabel} · ${modelLabel}`
  }

  return (
    <div className="flex max-h-[520px] w-[300px] flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-2.5 py-2">
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
          aria-controls="agent-composer-pop-roster"
          aria-activedescendant={selectedRow ? optionId(selectedRow) : undefined}
          className={`min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
        />
      </div>

      {composer.catalogStatus === 'loading' ? (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-disabled)]" role="status">
          Loading installed agents…
        </div>
      ) : composer.catalogStatus === 'error' ? (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-muted)]" role="status">
          {composer.catalogError ?? 'Could not load agent plugins.'} Showing built-in agents.
        </div>
      ) : composer.agentCliOptions.length === 0 ? (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--text-muted)]" role="status">
          No agent plugins installed.
        </div>
      ) : null}

      <div
        id="agent-composer-pop-roster"
        role="listbox"
        aria-label="Agents"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {visibleRows.length === 0 ? (
          <div className="px-3 py-5 text-center text-[11px] text-[color:var(--text-disabled)]">No matches</div>
        ) : (
          visibleRows.map((row, index) => {
            const prev = visibleRows[index - 1]
            const startsSpecialistSection =
              row.kind === 'specialist' && (!prev || prev.kind !== 'specialist')
            const persisted =
              selectMode &&
              action.kind === 'select' &&
              ((row.kind === 'specialist' && row.action.id === action.selectedSpecialistId) ||
                (row.kind === 'general' && !action.selectedSpecialistId))
            const target = selectionForRow(row)
            // Terminal has no runtime; Conversation picks its model in the chat
            // composer; select mode's engine is owned by the caller.
            const engineEditable = !selectMode && row.kind !== 'terminal' && row.kind !== 'conversation'
            return (
              <React.Fragment key={row.key}>
                {startsSpecialistSection && index > 0 ? (
                  <div className="mx-2 my-1 border-t border-[color:var(--border-subtle)]" />
                ) : null}
                <div className="relative">
                  <PopoverRosterRow
                    id={optionId(row)}
                    selected={rowMatchesSelection(row, selection)}
                    persisted={Boolean(persisted)}
                    icon={rowIcon(row, composer.cliForSelection(target))}
                    label={rowLabel(row)}
                    description={rowDescription(row)}
                    engineChip={
                      engineEditable ? (
                        <Tooltip placement="bottom" content={`Agent runtime: ${engineLabel(target)} · click to change`}>
                          <span
                            role="button"
                            tabIndex={-1}
                            aria-label={`Agent runtime for ${rowLabel(row)}: ${engineLabel(target)}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setEngineFlyoutRowKey((current) => (current === row.key ? null : row.key))
                            }}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-disabled)] transition-colors hover:text-[color:var(--text-strong)]"
                          >
                            <CliIcon cli={composer.cliForSelection(target)} className="icon-sm" />
                          </span>
                        </Tooltip>
                      ) : null
                    }
                    onHighlight={() => composer.setSelection(target)}
                    onCommit={() => commit(target)}
                    onOpenEngine={
                      engineEditable
                        ? () => setEngineFlyoutRowKey((current) => (current === row.key ? null : row.key))
                        : undefined
                    }
                  />
                  {engineEditable && engineFlyoutRowKey === row.key ? (
                    // primitive-duplication-allow: nested engine flyout inside the picker's floating surface; the surrounding surface owns outside-click and focus restoration.
                    <div
                      data-chip-popover="true"
                      aria-label={`Agent runtime for ${rowLabel(row)}`}
                      // design-tokens-allow: popover elevation matches OverflowMenu shadow for the same nested case.
                      className="fixed z-50 w-[220px] overflow-hidden rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface)] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                    >
                      <CliModelListbox
                        ariaLabel={`Agent runtime for ${rowLabel(row)}`}
                        options={row.kind === 'general' ? composer.generalCliOptions : composer.agentCliOptions}
                        currentCli={composer.cliForSelection(target)}
                        effectiveModelFor={(cli) => composer.modelForSelection(target, cli)}
                        effectiveReasoningFor={(cli) => composer.reasoningForSelection(target, cli)}
                        onSelectReasoning={(cli, reasoning) => composer.setEngineReasoning(target, cli, reasoning)}
                        onSelectCli={(cli) => {
                          composer.setEngineCli(target, cli)
                          setEngineFlyoutRowKey(null)
                        }}
                        onSelectModel={(cli, model) => {
                          composer.setEngineModel(target, cli, model)
                          setEngineFlyoutRowKey(null)
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </React.Fragment>
            )
          })
        )}
      </div>

      {/* The per-agent description now rides a hover tooltip on each row (see
          PopoverRosterRow), so the roster stays compact instead of reserving a
          fixed info strip. Each row's runtime stays discoverable via its engine
          chip tooltip. */}
      {skillAttachAvailable || worktreeAttachAvailable ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[color:var(--border-subtle)] px-2 py-1.5">
          {!skillAttachAvailable ? null : composer.skillAttachment ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[color:var(--text-strong)]">
              <StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />
              {composer.skillAttachment.name}
              <button
                type="button"
                onClick={() => composer.setSkillAttachment(null)}
                aria-label={`Remove skill ${composer.skillAttachment.name}`}
                className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
              >
                ×
              </button>
            </span>
          ) : (
            <SkillPickerPopover
              open={skillPickerOpen}
              onOpenChange={setSkillPickerOpen}
              workspaceRoot={activeWorkspaceRoot}
              onPick={(skill) => composer.setSkillAttachment(skill)}
              placement="bottom-start"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <button
                  ref={ref}
                  type="button"
                  onClick={togglePopover}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
                  {...triggerProps}
                >
                  + Skill
                </button>
              )}
            />
          )}
          {!worktreeAttachAvailable ? null : composer.worktreeName !== null ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-[11.5px] font-medium text-[color:var(--text-strong)]">
              Worktree
              <input
                autoFocus
                value={composer.worktreeName}
                onChange={(event) => composer.setWorktreeName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    composer.setWorktreeName(null)
                  }
                }}
                placeholder="name (auto)"
                aria-label="Worktree name — leave empty to derive from the agent's name"
                className={`w-24 min-w-0 bg-transparent font-normal text-[color:var(--text-default)] placeholder:text-[color:var(--text-subtle)] ${FOCUS_RING_CLASS}`}
              />
              <button
                type="button"
                onClick={() => composer.setWorktreeName(null)}
                aria-label="Remove worktree"
                className="text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)]"
              >
                ×
              </button>
            </span>
          ) : (
            <Tooltip
              content="Create a git worktree for this agent and run it there, isolated from the workspace checkout. Leave the name empty to derive it from the agent's name."
              placement="bottom"
            >
              <button
                type="button"
                onClick={() => composer.setWorktreeName('')}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
              >
                + Worktree
              </button>
            </Tooltip>
          )}
        </div>
      ) : null}
      <div className="flex items-center gap-1 border-t border-[color:var(--border-subtle)] px-2 py-1.5">
        <PermissionPresetChips value={action.permissionPreset} onChange={action.onChangePermissionPreset} />
        {action.kind === 'spawn' ? (
          <SpawnDebugToggle active={action.debugMode} onChange={action.onChangeDebugMode} />
        ) : null}
      </div>
    </div>
  )
}

// One sentence on what the highlighted row is, for the info strip. Specialist
// descriptions come from the pack; the quick rows carry the same copy the New
// Chat panel uses.
function rowDescription(row: ComposerRow): string {
  if (row.kind === 'terminal') return "A plain shell in this project's folder — no agent, no model."
  if (row.kind === 'general') {
    return 'A general-purpose agent with no role prompt — it runs your instructions as written.'
  }
  if (row.kind === 'conversation') return 'A chat agent — pick the provider model in the composer.'
  return row.action.description
}

function rowLabel(row: ComposerRow): string {
  if (row.kind === 'terminal') return 'Terminal'
  if (row.kind === 'general') return 'General agent'
  if (row.kind === 'conversation') return 'Conversation agent'
  return row.action.shortLabel
}

// The leading identity mark. The General row shows its own bound CLI (the
// caller passes that row's engine), never the highlighted row's — hovering the
// roster must not repaint other rows.
function rowIcon(row: ComposerRow, rowCli: AgentCli): React.ReactNode {
  if (row.kind === 'terminal') return <TerminalSessionIcon className="h-4 w-4" />
  if (row.kind === 'general') return <CliIcon cli={rowCli} className="h-4 w-4" />
  if (row.kind === 'conversation') return <ConversationProviderIcon className="h-4 w-4" />
  return <SpecialistActionIcon icon={row.action.icon} className="h-4 w-4" />
}

// A roster option. Click commits (spawns/selects) immediately; hover moves the
// keyboard highlight (accent inset bar) so Enter always targets the row under
// the pointer. `persisted` marks the durable choice in select mode with a
// trailing check. Right-click opens the engine flyout, mirroring the chip.
function PopoverRosterRow({
  id,
  selected,
  persisted,
  icon,
  label,
  description,
  engineChip,
  onHighlight,
  onCommit,
  onOpenEngine,
}: {
  id: string
  selected: boolean
  persisted: boolean
  icon: React.ReactNode
  label: string
  description: string
  engineChip: React.ReactNode
  onHighlight: () => void
  onCommit: () => void
  onOpenEngine?: () => void
}) {
  return (
    <Tooltip content={description} placement="left" wrapperClassName="block">
      <button
        type="button"
        id={id}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={onCommit}
        onMouseEnter={onHighlight}
        onContextMenu={(event) => {
          if (!onOpenEngine) return
          event.preventDefault()
          onHighlight()
          onOpenEngine()
        }}
        className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2 py-1.5 pl-2.5 pr-2 text-left transition-colors ${
          selected
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
        }`}
      >
        <span className={selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'}>{icon}</span>
        <TruncatedText as="span" text={label} className="text-[13px]" />
        {persisted ? (
          <svg className="icon-sm shrink-0 text-[color:var(--accent-primary)]" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5.2l2 2 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          engineChip ?? <span aria-hidden="true" />
        )}
      </button>
    </Tooltip>
  )
}
