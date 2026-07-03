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
  StatusDot,
  Tooltip,
  TruncatedText,
  type CliModelListboxOption,
  type LifecycleState,
  type Tone,
} from '../../ui'
import type {
  AgentCli,
  AgentState,
  SprintEngineRole,
  SprintEngineRoleId,
  SprintEngineState,
  SprintEngineTask,
} from '../../../types/workspace'
import {
  getSprintEngineRoleLabel,
  sprintEngineEnabledRoles,
  sprintEngineRoleOrder,
  type SprintEngineAgentRosterItem,
} from '../../../utils/sprintengine'
import {
  isSprintEnginePlanningRole,
  type SprintEngineAddMemberOption,
} from '../../../utils/sprintengineRoleOptions'
import { runtimeStatusLabel, type RuntimeAgentView } from '../sprintEngineInspector'
import { SprintEngineEmptyDetail } from './SprintEngineEmptyDetail'

// Runtime status → shape-coded lifecycle glyph. Status is earned, not
// decorated: an idle member gets no mark — its row reads as quiet — while the
// states that actually want attention (working, blocked, errored, finished)
// carry an indicator. A live agent that is *doing work* gets the pulsing green
// dot (the shared "agent working" idiom); the spinner is reserved for workspace
// runs and backlog items, never a live agent. The other, non-working states
// keep their lifecycle glyph.
type RosterIndicator =
  | { kind: 'dot'; tone: Tone; pulse: boolean }
  | { kind: 'glyph'; state: LifecycleState; live: boolean }

function rosterLifecycle(
  statusKey: string,
  spawnPending: boolean,
): RosterIndicator | null {
  if (spawnPending) return { kind: 'dot', tone: 'good', pulse: true }
  switch (statusKey) {
    case 'running':
    case 'planning':
      return { kind: 'dot', tone: 'good', pulse: true }
    case 'needs_input':
      return { kind: 'glyph', state: 'needs_input', live: false }
    case 'error':
      return { kind: 'glyph', state: 'failed', live: false }
    case 'complete':
      return { kind: 'glyph', state: 'done', live: false }
    case 'exited':
      return { kind: 'glyph', state: 'archived', live: false }
    default:
      return null
  }
}

// A role group is auto-expanded when it holds an agent that wants attention —
// a live terminal, an in-flight run, or a needs_input stop. Quiet roles
// (idle, done, empty) start collapsed so the team shape reads at a glance.
function isAttentionStatus(statusKey: string): boolean {
  return statusKey === 'running' || statusKey === 'planning' || statusKey === 'needs_input'
}

// A persistent reviewer holds its role's bare id (`<role>`), reserved by the
// id allocator (getNextSprintEngineAgentId) and registered on the role's first
// gate. Task workers are always task-scoped (`<role>-N`) and carry a
// `lastOwnedTaskId`, so a bare id that was never assigned an implementation task
// uniquely marks the gate-claiming identity that persists across tasks — the
// entry we tag distinctly from the per-task workers under the same role.
// Planners (architect / general) hold a bare id but are the run's planner, not
// a reviewer, so they carry no tag. The `lastOwnedTaskId` guard keeps a legacy
// bare implementer id (this run predates lazy seeding — e.g. a `frontend` id
// that claimed an implementation task) reading as a worker, not a reviewer.
function isPersistentReviewerEntry(
  agentId: string,
  role: SprintEngineRoleId,
  lastOwnedTaskId: string | null | undefined,
): boolean {
  return agentId === role && !isSprintEnginePlanningRole(role) && !lastOwnedTaskId
}

// `picker` is the right-click fast path — it surfaces the shared CLI/model
// listbox directly so the runtime can be picked in one gesture. `actions` is
// the row's ⋮ button: lifecycle controls (open/spawn/restart/kill) plus the
// same picker behind a flyout, kept for discoverability.
type RosterMenuTarget = { kind: 'picker' | 'actions'; agentId: string; x: number; y: number }

// Per-entry runtime descriptor, computed once and shared by the group header
// summary and the agent row so the two never disagree about status.
type RosterEntryDescriptor = {
  agent: SprintEngineAgentRosterItem
  runtime: RuntimeAgentView | null
  hasLiveTerminal: boolean
  spawnPending: boolean
  // Departed-but-resumable: not live, and spawnAgent's own resume gate
  // (willResumeAgent) says re-opening this id would resume its recorded
  // conversation rather than start fresh. Drives the primary action's Resume vs
  // Spawn split; a never-run or resume-incapable id is not resumable → Spawn.
  resumable: boolean
  statusKey: string
  statusLabel: string
  displayName: string
  roleSlotLabel: string | null
  isReviewer: boolean
  tasks: { id: string; title: string | null }[]
}

// Roster tab: role-grouped agent list + detail. Top level is one row per role
// that is enabled or has entries (glyph, label, live-session count, newest
// activity, expand chevron); expanding a role reveals its sessions newest
// first. Each session row stays the runtime control surface for that member:
// identity, earned status, owned task(s), CLI/model, and lifecycle actions.
// Row actions (open/spawn, the row menu) reveal on hover, focus, or selection
// so a dormant roster reads as a calm list rather than a wall of buttons.
// Right-clicking any row opens the shared CLI/model picker directly. The
// inspector (right) opens when an agent entry is selected, unchanged.
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
  willResumeAgent,
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
  // Whether spawnAgent would RESUME this id's recorded conversation rather than
  // start fresh — the shared spawn-side resume gate. Drives the Resume-vs-Spawn
  // label so it never disagrees with what the click actually does. Not
  // live-aware, so the view combines it with its own liveness check.
  willResumeAgent: (agentId: string) => boolean
  onRestartAgent: (agentId: string) => void
  onKillAgent: (agentId: string) => void
  inspectorContent: React.ReactNode
  inspectorExpanded: boolean
}) {
  const hasInspector = inspectorContent !== null && inspectorContent !== undefined
  const [menu, setMenu] = useState<RosterMenuTarget | null>(null)
  // View-local expansion overrides keyed by role. Absent => fall back to the
  // data-driven default (attention roles open, quiet roles collapsed). Not
  // persisted; resets with the view.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({})

  const menuAgent = menu ? roster.find((agent) => agent.id === menu.agentId) ?? null : null

  const describeEntry = (agent: SprintEngineAgentRosterItem): RosterEntryDescriptor => {
    const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
    const hasLiveTerminal = isAgentTerminalLive(agent.id)
    const agentState = agents[agent.id]
    const spawnPending = Boolean(agentState?.cliStartRequested) && !hasLiveTerminal
    const statusKey = runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')
    const statusLabel = spawnPending ? 'Starting' : runtimeStatusLabel(statusKey)
    const displayName = agentState?.name?.trim() || agent.label
    const roleSlotLabel = agent.label !== displayName ? agent.label : null
    // Owned task(s) rendered as a list — never assume exactly one per agent so
    // a future multi-task reuse policy stays UI-neutral. Today (per_task) this
    // is a list of one: the current claim, or the last owned task once done.
    const record = sprintEngineState.sprintEngineAgents[agent.id]
    const lastOwnedTaskId = record?.lastOwnedTaskId ?? null
    const taskIds: string[] = []
    for (const id of [runtime?.currentTaskId, lastOwnedTaskId]) {
      if (id && !taskIds.includes(id)) taskIds.push(id)
    }
    const tasks = taskIds.map((id) => {
      const task: SprintEngineTask | undefined = sprintEngineState.tasks.find((entry) => entry.id === id)
      return { id, title: task?.title ?? null }
    })
    return {
      agent,
      runtime,
      hasLiveTerminal,
      spawnPending,
      // Not live + spawnAgent's own resume gate (willResumeAgent) says re-opening
      // this id would resume its recorded conversation rather than spawn fresh.
      // Sharing that gate keeps the label from claiming Resume for a never-run or
      // resume-incapable id that actually fresh-spawns.
      resumable: !hasLiveTerminal && willResumeAgent(agent.id),
      statusKey,
      statusLabel,
      displayName,
      roleSlotLabel,
      isReviewer: isPersistentReviewerEntry(agent.id, agent.role, lastOwnedTaskId),
      tasks,
    }
  }

  // Group roster entries by role, newest first. The roster arrives sorted
  // ascending by role index; reversing each group puts the most recently
  // minted session on top, with the persistent reviewer id settling to the
  // stable bottom.
  const entriesByRole = new Map<SprintEngineRoleId, SprintEngineAgentRosterItem[]>()
  for (const agent of roster) {
    const list = entriesByRole.get(agent.role)
    if (list) list.push(agent)
    else entriesByRole.set(agent.role, [agent])
  }
  for (const list of entriesByRole.values()) list.reverse()

  // Role rows to show: every enabled (configured) role plus any role that has
  // entries. Enabled-but-empty roles render as collapsed empty groups so the
  // team shape is visible before work starts. Canonical role order (bundled
  // first, then custom roles alphabetically) — the same ordering the roster
  // builder uses so groups and entries never disagree.
  const optionByRole = new Map(addMemberOptions.map((option) => [option.role, option]))
  const enabledRoles = new Set(sprintEngineEnabledRoles(sprintEngineState.roleCounts))
  const rolePriority = (role: SprintEngineRoleId): number => {
    const index = sprintEngineRoleOrder.indexOf(role as SprintEngineRole)
    return index >= 0 ? index : sprintEngineRoleOrder.length
  }
  const roleOrder = [...new Set<SprintEngineRoleId>([...enabledRoles, ...entriesByRole.keys()])].sort(
    (a, b) => rolePriority(a) - rolePriority(b) || a.localeCompare(b),
  )

  const roleLabelFor = (role: SprintEngineRoleId): string =>
    optionByRole.get(role)?.label ?? getSprintEngineRoleLabel(role)

  return (
    <div className="flex min-h-0 flex-1 min-w-0">
      {inspectorExpanded ? null : (
        <SidePane as="section" side="left" width="lg" ariaLabel="Roster">
          <div className="flex-1 overflow-auto">
            {roleOrder.length === 0 ? (
              <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-subtle)]">
                No roles on this run yet. Pick a role below to add the first member.
              </div>
            ) : (
              roleOrder.map((role) => {
                const entries = entriesByRole.get(role) ?? []
                const descriptors = entries.map(describeEntry)
                const liveCount = descriptors.filter((entry) => entry.hasLiveTerminal).length
                // Auto-expand a group that wants attention (live / needs_input)
                // or holds the currently selected agent, so its row is never
                // hidden behind a collapsed header.
                const defaultExpanded = descriptors.some(
                  (entry) =>
                    entry.hasLiveTerminal
                    || isAttentionStatus(entry.statusKey)
                    || entry.agent.id === selectedAgentId,
                )
                const expanded = expandOverrides[role] ?? defaultExpanded
                const listId = `roster-group-${role}`
                const roleLabel = roleLabelFor(role)
                // Newest activity summary: the newest attention entry (else the
                // newest entry), shown as its owned task or its status.
                const lead =
                  descriptors.find((entry) => isAttentionStatus(entry.statusKey)) ?? descriptors[0] ?? null
                const summary = lead
                  ? lead.tasks[0]
                    ? `${lead.tasks[0].id}${lead.tasks[0].title ? ` · ${lead.tasks[0].title}` : ''}`
                    : lead.statusLabel
                  : 'No sessions yet'
                return (
                  <section key={role} className="border-b border-[color:var(--border-default)]">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandOverrides((prev) => ({ ...prev, [role]: !expanded }))
                      }
                      aria-expanded={expanded}
                      // The controlled list only renders while expanded, so point
                      // aria-controls at it only then — never at an id absent from
                      // the DOM.
                      aria-controls={expanded ? listId : undefined}
                      className="interactive flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[color:var(--bg-surface)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className={`icon-sm shrink-0 text-[color:var(--text-disabled)] transition-transform ${expanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        aria-hidden="true"
                      >
                        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <RoleAvatar role={role} size="sm" ariaLabel="" />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <TruncatedText
                            as="span"
                            text={roleLabel}
                            className="min-w-0 flex-1 text-[13px] font-medium text-[color:var(--text-strong)]"
                          />
                          {liveCount > 0 ? (
                            <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-muted)]">
                              {liveCount} active
                            </span>
                          ) : null}
                        </span>
                        <TruncatedText
                          as="span"
                          text={summary}
                          className="block text-[11px] text-[color:var(--text-subtle)]"
                        />
                      </span>
                    </button>

                    {expanded ? (
                      entries.length === 0 ? (
                        <p
                          id={listId}
                          className="px-3 pb-2.5 pl-[52px] text-[11px] text-[color:var(--text-subtle)]"
                        >
                          No sessions yet.
                        </p>
                      ) : (
                        <ol id={listId} aria-label={`${roleLabel} agents`}>
                          {descriptors.map((descriptor) => renderAgentRow(descriptor))}
                        </ol>
                      )
                    ) : null}
                  </section>
                )
              })
            )}
          </div>

          {/* Only roles not yet enabled on the team: an enabled role renders
              as a group (with entries, or empty), never an add chip. Same-role
              capacity grows on demand via queue-depth replenishment (MC-1450
              retired manual "add another" and the per-role count badge). Hidden
              entirely when every addable role is already enabled. */}
          {addMemberOptions.some((option) => option.activeForRole === 0 && !enabledRoles.has(option.role)) ? (
          <section
            aria-label="Add a role to the roster"
            className="shrink-0 border-t border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
          >
            <div className="px-3 pb-1 pt-2">
              <h4 className="text-[11px] font-medium text-[color:var(--text-muted)]">Add role</h4>
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
              {addMemberOptions.filter((option) => option.activeForRole === 0 && !enabledRoles.has(option.role)).map((option) => {
                const role = option.role
                const addLabel = `Add ${option.label}`
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
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          </section>
          ) : null}
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
        // Same Resume/Spawn split as the row primary action, so the menu never
        // says "Spawn" for an id whose recorded conversation would be resumed.
        const resumable = !live && willResumeAgent(menuAgent.id)
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
                {pending ? 'Starting…' : resumable ? 'Resume agent' : 'Spawn agent'}
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

  // A single agent entry within an expanded role group. Keeps every affordance
  // of the pre-grouping flat row: identity, earned status, CLI/model summary,
  // owned task list, primary open/spawn action, and the ⋮ lifecycle menu.
  function renderAgentRow(descriptor: RosterEntryDescriptor): React.ReactNode {
    const { agent, spawnPending, resumable, statusKey, statusLabel, displayName, roleSlotLabel, isReviewer, tasks } =
      descriptor
    const hasLiveTerminal = descriptor.hasLiveTerminal
    const lifecycle = rosterLifecycle(statusKey, spawnPending)
    const runtimeSummary = runtimeSummaryFor(agent.id)
    const selected = selectedAgentId === agent.id
    return (
      <li key={agent.id}>
        <div
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ kind: 'picker', agentId: agent.id, x: event.clientX, y: event.clientY })
          }}
          className={`group relative flex w-full min-w-0 items-center gap-2 border-t border-[color:var(--border-subtle)] pr-2 ${
            selected
              ? 'bg-[color:var(--bg-hover)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-[color:var(--accent-primary)]'
              : 'hover:bg-[color:var(--bg-surface)]'
          }`}
        >
          <button
            type="button"
            onClick={() => onSelectAgent(agent.id)}
            aria-pressed={selected}
            className={`interactive flex min-w-0 flex-1 gap-2.5 py-2.5 pl-[52px] pr-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset ${
              selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
            }`}
          >
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <TruncatedText
                  as="span"
                  text={displayName}
                  className="min-w-0 flex-1 text-[13px] font-medium"
                />
                {isReviewer ? (
                  <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">Reviewer</span>
                ) : roleSlotLabel ? (
                  <TruncatedText
                    as="span"
                    text={roleSlotLabel}
                    className="min-w-0 shrink text-[11px] text-[color:var(--text-muted)]"
                  />
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
                {lifecycle ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    {lifecycle.kind === 'dot' ? (
                      // Decorative: the adjacent <span>{statusLabel}</span> is the
                      // single spoken source for the state, so the dot omits its
                      // label (renders aria-hidden) to avoid a double-announce.
                      <StatusDot tone={lifecycle.tone} pulse={lifecycle.pulse} />
                    ) : (
                      <LifecycleGlyph state={lifecycle.state} live={lifecycle.live} />
                    )}
                    <span>{statusLabel}</span>
                  </span>
                ) : null}
                {runtimeSummary ? (
                  <TruncatedText as="span" text={runtimeSummary} className="shrink-0 text-[color:var(--text-muted)]" />
                ) : null}
              </span>
              {tasks.length > 0 ? (
                <ul className="min-w-0 space-y-0.5 text-[11px] text-[color:var(--text-subtle)]">
                  {tasks.map((task) => (
                    <li key={task.id} className="min-w-0 truncate">
                      <span className="font-mono text-[color:var(--text-muted)]">{task.id}</span>
                      {task.title ? (
                        <>
                          <span className="text-[color:var(--text-disabled)]"> · </span>
                          <span>{task.title}</span>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
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
                aria-label={
                  spawnPending
                    ? `${displayName} is starting`
                    : resumable
                      ? `Resume ${displayName}`
                      : `Spawn ${displayName}`
                }
                className="interactive inline-flex h-6 items-center rounded px-2 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-default disabled:opacity-50"
              >
                {spawnPending ? 'Starting…' : resumable ? 'Resume' : 'Spawn'}
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
  }
}
