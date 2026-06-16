import React, { useState } from 'react'
import {
  CliModelListbox,
  ContextMenu,
  LifecycleGlyph,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  RoleAvatar,
  SidePane,
  Tooltip,
  type CliModelListboxOption,
  type LifecycleState,
} from '../../ui'
import type {
  AgentCli,
  AgentState,
  SprintEngineRole,
  SprintEngineState,
} from '../../../types/workspace'
import type { SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import type { SprintEngineAddMemberOption } from '../../../utils/sprintengineRoleOptions'
import { runtimeStatusLabel, type RuntimeAgentView } from '../sprintEngineInspector'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'

// Runtime status → shape-coded lifecycle glyph. Status is earned, not
// decorated: an idle member gets no mark — its row reads as quiet — while the
// states that actually want attention (working, blocked, errored, finished)
// carry a glyph. Only the genuinely live states spin.
function rosterLifecycle(
  statusKey: string,
  spawnPending: boolean,
): { state: LifecycleState; live: boolean } | null {
  if (spawnPending) return { state: 'in_progress', live: true }
  switch (statusKey) {
    case 'running':
    case 'planning':
      return { state: 'in_progress', live: true }
    case 'needs_input':
      return { state: 'needs_input', live: false }
    case 'error':
      return { state: 'failed', live: false }
    case 'complete':
      return { state: 'done', live: false }
    case 'exited':
      return { state: 'archived', live: false }
    default:
      return null
  }
}

// `picker` is the right-click fast path — it surfaces the shared CLI/model
// listbox directly so the runtime can be picked in one gesture. `actions` is
// the row's ⋮ button: lifecycle controls (open/spawn/restart/kill) plus the
// same picker behind a flyout, kept for discoverability.
type RosterMenuTarget = { kind: 'picker' | 'actions'; agentId: string; x: number; y: number }

// Roster tab: agent list + detail. Mirrors the Inbox shape — roster on the
// left, inspector (with agent-specific actions) on the right when an agent
// is selected. Each row is the runtime control surface for that member:
// identity, earned status, active task, and CLI/model. Row actions
// (open/spawn, the row menu) reveal on hover, focus, or selection so a
// dormant roster reads as a calm list rather than a wall of buttons.
// Right-clicking any row opens the shared CLI/model picker directly — the
// one gesture for choosing a member's runtime. The row's ⋮ button opens the
// lifecycle menu (open/spawn/restart/kill), which also carries the picker
// behind a flyout for discoverability.
export function SprintEngineRosterView({
  sprintEngineState,
  roster,
  agents,
  runtimeAgents,
  selectedAgentId,
  onSelectAgent,
  onAddRole,
  addMemberOptions,
  isAgentTerminalLive,
  runtimeSummaryFor,
  cliOptions,
  agentRuntimeCli,
  effectiveModelForAgent,
  onSelectAgentCli,
  onSelectAgentModel,
  onOpenAgent,
  onSpawnAgent,
  onRestartAgent,
  onKillAgent,
  inspectorContent,
  inspectorExpanded,
}: {
  sprintEngineState: SprintEngineState
  roster: SprintEngineAgentRosterItem[]
  agents: Record<string, AgentState>
  runtimeAgents: RuntimeAgentView[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  onAddRole: (role: SprintEngineRole) => void
  addMemberOptions: SprintEngineAddMemberOption[]
  isAgentTerminalLive: (agentId: string) => boolean
  // "CLI · model" summary for the row meta line; null hides the segment.
  runtimeSummaryFor: (agentId: string) => string | null
  // Shared CLI/model picker wiring, reused from the spawn/add-member dialogs.
  cliOptions: CliModelListboxOption[]
  agentRuntimeCli: (agentId: string) => AgentCli
  effectiveModelForAgent: (agentId: string, cli: AgentCli) => string | undefined
  onSelectAgentCli: (agentId: string, cli: AgentCli) => void
  onSelectAgentModel: (agentId: string, cli: AgentCli, model: string | null) => void
  onOpenAgent: (agentId: string) => void
  onSpawnAgent: (agentId: string) => void
  onRestartAgent: (agentId: string) => void
  onKillAgent: (agentId: string) => void
  inspectorContent: React.ReactNode
  inspectorExpanded: boolean
}) {
  const hasInspector = inspectorContent !== null && inspectorContent !== undefined
  const [menu, setMenu] = useState<RosterMenuTarget | null>(null)

  const menuAgent = menu ? roster.find((agent) => agent.id === menu.agentId) ?? null : null

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      {inspectorExpanded ? null : (
        <SidePane as="section" side="left" width="lg" ariaLabel="Roster agents">
          <div className="flex-1 overflow-auto">
            {roster.length === 0 ? (
              <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-subtle)]">
                No agents on roster yet. Pick a role below to add the first member.
              </div>
            ) : (
              <ol aria-label="Roster agents">
                {roster.map((agent) => {
                  const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
                  const hasLiveTerminal = isAgentTerminalLive(agent.id)
                  const agentState = agents[agent.id]
                  const spawnPending = Boolean(agentState?.cliStartRequested) && !hasLiveTerminal
                  const statusKey = runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')
                  const lifecycle = rosterLifecycle(statusKey, spawnPending)
                  const statusLabel = spawnPending ? 'Starting' : runtimeStatusLabel(statusKey)
                  const displayName = agentState?.name?.trim() || agent.label
                  const roleSlotLabel = agent.label !== displayName ? agent.label : null
                  const runtimeSummary = runtimeSummaryFor(agent.id)
                  const currentTask = runtime?.currentTaskId
                    ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
                    : null
                  const selected = selectedAgentId === agent.id
                  return (
                    <li key={agent.id}>
                      <div
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setMenu({ kind: 'picker', agentId: agent.id, x: event.clientX, y: event.clientY })
                        }}
                        className={`group relative flex w-full min-w-0 items-center gap-2 border-b border-[color:var(--border-default)] pr-2 ${
                          selected
                            ? 'bg-[color:var(--bg-hover)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-[color:var(--accent-primary)]'
                            : 'hover:bg-[color:var(--bg-surface)]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectAgent(agent.id)}
                          aria-pressed={selected}
                          className={`interactive flex min-w-0 flex-1 gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset ${
                            selected
                              ? 'pl-[9px] text-[color:var(--text-strong)]'
                              : 'text-[color:var(--text-default)]'
                          }`}
                        >
                          <RoleAvatar role={agent.role} size="md" className="mt-0.5" ariaLabel="" />
                          <span className="min-w-0 flex-1 space-y-0.5">
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                {displayName}
                              </span>
                              {roleSlotLabel ? (
                                <span className="min-w-0 shrink truncate text-[11px] text-[color:var(--text-muted)]">
                                  {roleSlotLabel}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex min-w-0 items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
                              {lifecycle ? (
                                <span className="flex shrink-0 items-center gap-1.5">
                                  <LifecycleGlyph state={lifecycle.state} live={lifecycle.live} />
                                  <span>{statusLabel}</span>
                                </span>
                              ) : null}
                              {runtimeSummary ? (
                                <span className="shrink-0 truncate text-[color:var(--text-muted)]">{runtimeSummary}</span>
                              ) : null}
                              {currentTask ? (
                                <span className="min-w-0 truncate">
                                  <span className="font-mono text-[color:var(--text-muted)]">{currentTask.id}</span>
                                  <span className="text-[color:var(--text-disabled)]"> · </span>
                                  <span>{currentTask.title}</span>
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </button>
                        <span
                          className={`flex shrink-0 items-center gap-1 transition-opacity ${
                            selected
                              ? 'opacity-100'
                              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                          }`}
                        >
                          {hasLiveTerminal ? (
                            <button
                              type="button"
                              onClick={() => onOpenAgent(agent.id)}
                              aria-label={`Open ${displayName} terminal`}
                              className="interactive inline-flex h-6 items-center rounded px-2 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                            >
                              Open
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onSpawnAgent(agent.id)}
                              disabled={spawnPending}
                              aria-label={spawnPending ? `${displayName} is starting` : `Spawn ${displayName}`}
                              className="interactive inline-flex h-6 items-center rounded px-2 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-default disabled:opacity-50"
                            >
                              {spawnPending ? 'Starting…' : 'Spawn'}
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`${displayName} actions`}
                            aria-haspopup="menu"
                            onClick={(event) => {
                              event.stopPropagation()
                              const rect = event.currentTarget.getBoundingClientRect()
                              setMenu({ kind: 'actions', agentId: agent.id, x: rect.right, y: rect.bottom })
                            }}
                            className="interactive inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--text-disabled)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                          >
                            <svg viewBox="0 0 16 16" className="icon-sm" fill="currentColor" aria-hidden="true">
                              <circle cx="8" cy="3.4" r="1.3" />
                              <circle cx="8" cy="8" r="1.3" />
                              <circle cx="8" cy="12.6" r="1.3" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          <section
            aria-label="Add a roster member"
            className="shrink-0 border-t border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
          >
            <div className="px-3 pb-1 pt-2">
              <h4 className="text-[11px] font-medium text-[color:var(--text-muted)]">Add member</h4>
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
              {addMemberOptions.map((option) => {
                const role = option.role
                const count = option.activeForRole
                const addLabel = `${count > 0 ? 'Add another' : 'Add'} ${option.label}`
                return (
                  <Tooltip key={role} content={addLabel}>
                    <button
                      type="button"
                      onClick={() => onAddRole(role as SprintEngineRole)}
                      aria-label={addLabel}
                      className="interactive inline-flex items-center gap-1.5 rounded border border-[color:var(--border-default)] px-2 py-1 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                    >
                      <RoleAvatar role={role} size="xs" ariaLabel="" />
                      <span>{option.label}</span>
                      {count > 0 ? (
                        <span className="ml-0.5 tabular-nums text-[color:var(--text-disabled)]">{count}</span>
                      ) : null}
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          </section>
        </SidePane>
      )}

      {hasInspector ? (
        <section
          className="flex min-w-0 flex-1 flex-col"
          aria-label="Selected agent detail"
        >
          {inspectorContent}
        </section>
      ) : (
        <SprintEngineEmptyDetail
          message={
            roster.length > 0
              ? 'Select an agent on the left to open their terminal, see current task, or focus the session.'
              : 'Add a role from the footer to put the first agent on the roster.'
          }
        />
      )}

      {menu && menuAgent ? (() => {
        const live = isAgentTerminalLive(menuAgent.id)
        const agentState = agents[menuAgent.id]
        const pending = Boolean(agentState?.cliStartRequested) && !live
        const displayName = agentState?.name?.trim() || menuAgent.label
        const close = () => setMenu(null)

        // Right-click fast path: the shared CLI/model picker on its own, the
        // single gesture for choosing this member's runtime.
        if (menu.kind === 'picker') {
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              ariaLabel={`Runtime for ${displayName}`}
              onClose={close}
              surfaceClassName="w-[220px] p-1"
            >
              <CliModelListbox
                ariaLabel={`Runtime options for ${displayName}`}
                options={cliOptions}
                currentCli={agentRuntimeCli(menuAgent.id)}
                effectiveModelFor={(cli) => effectiveModelForAgent(menuAgent.id, cli)}
                onSelectCli={(cli) => { onSelectAgentCli(menuAgent.id, cli); close() }}
                onSelectModel={(cli, model) => { onSelectAgentModel(menuAgent.id, cli, model); close() }}
              />
            </ContextMenu>
          )
        }

        return (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            ariaLabel={`${displayName} actions menu`}
            onClose={close}
            surfaceClassName="min-w-[200px]"
          >
            {live ? (
              <MenuItem onClick={() => { onOpenAgent(menuAgent.id); close() }}>Open terminal</MenuItem>
            ) : (
              <MenuItem disabled={pending} onClick={() => { onSpawnAgent(menuAgent.id); close() }}>
                {pending ? 'Starting…' : 'Spawn agent'}
              </MenuItem>
            )}
            <MenuFlyoutItem
              label="CLI / model"
              ariaLabel={`Runtime for ${displayName}`}
              surfaceClassName="min-w-[220px] p-1"
            >
              <CliModelListbox
                ariaLabel={`Runtime options for ${displayName}`}
                options={cliOptions}
                currentCli={agentRuntimeCli(menuAgent.id)}
                effectiveModelFor={(cli) => effectiveModelForAgent(menuAgent.id, cli)}
                onSelectCli={(cli) => { onSelectAgentCli(menuAgent.id, cli); close() }}
                onSelectModel={(cli, model) => { onSelectAgentModel(menuAgent.id, cli, model); close() }}
              />
            </MenuFlyoutItem>
            {live ? (
              <>
                <MenuItem onClick={() => { onRestartAgent(menuAgent.id); close() }}>Restart fresh</MenuItem>
                <MenuDivider />
                <MenuItem variant="danger" onClick={() => { onKillAgent(menuAgent.id); close() }}>
                  Kill terminal
                </MenuItem>
              </>
            ) : null}
          </ContextMenu>
        )
      })() : null}
    </div>
  )
}
