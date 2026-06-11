import React from 'react'
import { OverflowMenu, RoleAvatar, SidePane, Spinner, Tooltip } from '../../ui'
import type {
  AgentState,
  SprintEngineRole,
  SprintEngineState,
} from '../../../types/workspace'
import type { SprintEngineAgentRosterItem } from '../../../utils/sprintengine'
import type { SprintEngineAddMemberOption } from '../../../utils/sprintengineRoleOptions'
import type { RuntimeAgentView } from '../sprintEngineInspector'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'

// Roster tab: agent list + detail. Mirrors the Inbox shape — roster on the
// left, inspector (with agent-specific actions) on the right when an agent
// is selected. Each row is the runtime control surface for that member:
// status, active task, CLI/model, a primary Open/Spawn action, and a row
// menu for restart/kill. Add-member affordance sticks to the foot of the
// list rail so it stays one click away regardless of roster size.
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
  onOpenAgent: (agentId: string) => void
  onSpawnAgent: (agentId: string) => void
  onRestartAgent: (agentId: string) => void
  onKillAgent: (agentId: string) => void
  inspectorContent: React.ReactNode
  inspectorExpanded: boolean
}) {
  const hasInspector = inspectorContent !== null && inspectorContent !== undefined

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
                              <span className="flex shrink-0 items-center gap-1.5">
                                {statusKey === 'running' || spawnPending ? <Spinner size={12} /> : null}
                                <span className="capitalize">{spawnPending ? 'Starting' : statusKey}</span>
                              </span>
                              {runtimeSummary ? (
                                <span className="shrink-0 truncate text-[color:var(--text-muted)]">{runtimeSummary}</span>
                              ) : null}
                              {currentTask ? (
                                <span className="min-w-0 truncate">
                                  <span className="font-mono text-[color:var(--text-muted)]">{currentTask.id}</span>
                                  <span className="text-[color:var(--text-disabled)]"> · </span>
                                  <span>{currentTask.title}</span>
                                </span>
                              ) : (
                                <span className="text-[color:var(--text-disabled)]">No active task</span>
                              )}
                            </span>
                          </span>
                        </button>
                        <span className="flex shrink-0 items-center gap-1">
                          {hasLiveTerminal ? (
                            <button
                              type="button"
                              onClick={() => onOpenAgent(agent.id)}
                              aria-label={`Open ${displayName} terminal`}
                              className="interactive inline-flex h-6 items-center rounded border border-[color:var(--border-strong)] px-2 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--accent-primary-soft)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                            >
                              Open
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onSpawnAgent(agent.id)}
                              disabled={spawnPending}
                              aria-label={spawnPending ? `${displayName} is starting` : `Spawn ${displayName}`}
                              className="interactive inline-flex h-6 items-center rounded border border-[color:var(--border-strong)] px-2 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--accent-primary-soft)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-default disabled:opacity-50"
                            >
                              {spawnPending ? 'Starting…' : 'Spawn'}
                            </button>
                          )}
                          <OverflowMenu
                            ariaLabel={`${displayName} actions`}
                            items={
                              hasLiveTerminal
                                ? [
                                  {
                                    id: 'change-runtime',
                                    label: 'Change CLI / model…',
                                    onSelect: () => onSpawnAgent(agent.id),
                                  },
                                  {
                                    id: 'restart',
                                    label: 'Restart fresh',
                                    onSelect: () => onRestartAgent(agent.id),
                                  },
                                  { kind: 'separator' as const, id: 'sep' },
                                  {
                                    id: 'kill',
                                    label: 'Kill terminal',
                                    destructive: true,
                                    onSelect: () => onKillAgent(agent.id),
                                  },
                                ]
                                : [
                                  {
                                    id: 'spawn-options',
                                    label: 'Spawn with CLI / model…',
                                    disabled: spawnPending,
                                    onSelect: () => onSpawnAgent(agent.id),
                                  },
                                ]
                            }
                          />
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
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <h4 className="truncate text-[11px] font-semibold text-[color:var(--text-muted)]">
                Add member
              </h4>
              <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
                {addMemberOptions.length} roles
              </span>
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
                      className="interactive inline-flex items-center gap-1.5 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-1 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--accent-primary-soft)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
                    >
                      <RoleAvatar role={role} size="xs" ariaLabel="" />
                      <span>{option.label}</span>
                      {count > 0 ? (
                        <span className="ml-0.5 rounded bg-[color:var(--bg-hover)] px-1 tabular-nums text-[color:var(--text-muted)]">
                          {count}
                        </span>
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
    </div>
  )
}
