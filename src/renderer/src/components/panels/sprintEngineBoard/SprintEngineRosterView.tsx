import React, { useState } from 'react'
import {
  CliModelListbox,
  CliModelPickerButton,
  ContextMenu,
  GhostButton,
  LifecycleGlyph,
  MenuDivider,
  MenuFlyoutItem,
  MenuItem,
  OutlineButton,
  Popover,
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
  type SprintEngineAddMemberOption,
} from '../../../utils/sprintengineRoleOptions'
import { runtimeStatusLabel, type RuntimeAgentView } from '../sprintEngineInspector'

// Runtime status → shape-coded lifecycle indicator. Status is earned, not
// decorated: an idle member gets no mark — its row reads as quiet — while the
// states that actually want attention (working, blocked, errored, finished)
// carry an indicator. A live agent that is *doing work* gets the pulsing green
// dot (the shared "agent working" idiom); the other states keep their
// lifecycle glyph.
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

// Hover copy for the lifecycle glyphs. The dot states (running/planning) read
// on their own; the glyph states are ambiguous shapes, so each one explains
// itself in plain words.
function rosterStatusTooltip(statusKey: string, statusLabel: string): string {
  switch (statusKey) {
    case 'needs_input':
      return 'Waiting on an answer — this agent is blocked until someone replies.'
    case 'error':
      return 'This agent’s session hit an error.'
    case 'complete':
      return 'This agent finished its work.'
    case 'exited':
      return 'This agent’s session has ended — it ran earlier and is no longer running. Right-click to start it again.'
    default:
      return statusLabel
  }
}

// `picker` is the right-click fast path — it surfaces the shared CLI/model
// listbox directly as this one agent's runtime escape hatch. `actions` is the
// row's ⋮ button: lifecycle controls (open/spawn/restart/kill) plus the same
// per-agent picker behind a flyout.
type RosterMenuTarget = { kind: 'picker' | 'actions'; agentId: string; x: number; y: number }

// Per-entry descriptor, computed once per row render.
type RosterEntryDescriptor = {
  agent: SprintEngineAgentRosterItem
  runtime: RuntimeAgentView | null
  hasLiveTerminal: boolean
  spawnPending: boolean
  // Departed-but-resumable: not live, and spawnAgent's own resume gate
  // (willResumeAgent) says re-opening this id would resume its recorded
  // conversation rather than start fresh.
  resumable: boolean
  statusKey: string
  statusLabel: string
  displayName: string
  // Single activity line: the current/last owned task, else the status label.
  activity: string
  // The launched-vs-configured runtime divergence label ("on <model>"), shown
  // only while a live session still runs a runtime that differs from the
  // record's reconciled config (i.e. after a mid-run role edit). Null = in
  // sync or unknowable (no launch stamp / not live) — say nothing.
  divergedFrom: string | null
  // Divergence + not currently working → the restart offer is actionable now.
  offerRestart: boolean
}

// Agents tab, re-sourced from the projection's derived workers view
// (MC-1593a): a slim header (census + the two run-config controls) over flat
// role sections — a role band carrying the role-level facts (its live/total
// count + the role's model, editable in place via the shared quiet
// CliModelPickerButton) above single-line agent rows on the same left edge. No
// tree indentation, no side pane, no inspector split: opening an agent jumps to
// its terminal tab. Editing a role's model mutates the run's canonical
// roleRuntimes (role edit wins — the host clears per-agent overrides); live
// agents are never interrupted — an idle diverged agent gets a visible Restart
// offer, a working one shows a muted "on <old model>" label and switches at its
// next natural launch. The census counts who is working and how many roles the
// run configures; the header controls "Add a role" (enables another role in the
// run config) and "Add an agent" (raises the concurrent-agent count and spawns
// one now) replace the old single seat-grammar "Add member" menu.
export function SprintEngineRosterView({
  sprintEngineState,
  roster,
  agents,
  runtimeAgents,
  addMemberOptions,
  onEnableRole,
  onAddAgent,
  isAgentTerminalLive,
  willResumeAgent,
  cliOptions,
  roleRuntimeCli,
  roleRuntimeModel,
  onSelectRoleCli,
  onSelectRoleModel,
  agentRuntimeCli,
  effectiveModelForAgent,
  onSelectAgentCli,
  onSelectAgentModel,
  onOpenAgent,
  onSpawnAgent,
  onRestartAgent,
  onKillAgent,
  terminalActionsUnavailable,
  roleConfigUnavailable,
}: {
  sprintEngineState: SprintEngineState
  roster: SprintEngineAgentRosterItem[]
  agents: Record<string, AgentState>
  runtimeAgents: RuntimeAgentView[]
  addMemberOptions: SprintEngineAddMemberOption[]
  // Enable a role the run does not yet configure (writes configuredRoles /
  // roleRuntimes via the host). Its band appears immediately.
  onEnableRole: (role: SprintEngineRole) => void
  // Raise the run's concurrent-agent count and mint + spawn one agent of the
  // chosen configured role now (writes maxConcurrentAgents via the host).
  onAddAgent: (role: SprintEngineRole) => void
  isAgentTerminalLive: (agentId: string) => boolean
  willResumeAgent: (agentId: string) => boolean
  cliOptions: CliModelListboxOption[]
  // Role-level runtime control (the band's in-place editor). Writes go to the
  // run's canonical roleRuntimes via the host — never renderer state.
  roleRuntimeCli: (role: SprintEngineRoleId) => AgentCli
  roleRuntimeModel: (role: SprintEngineRoleId, cli: AgentCli) => string | undefined
  onSelectRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSelectRoleModel: (role: SprintEngineRoleId, cli: AgentCli, model: string | null) => void
  // Per-agent runtime escape hatch (⋮ flyout / right-click), unchanged.
  agentRuntimeCli: (agentId: string) => AgentCli
  effectiveModelForAgent: (agentId: string, cli: AgentCli) => string | undefined
  onSelectAgentCli: (agentId: string, cli: AgentCli) => void
  onSelectAgentModel: (agentId: string, cli: AgentCli, model: string | null) => void
  onOpenAgent: (agentId: string) => void
  onSpawnAgent: (agentId: string) => void
  onRestartAgent: (agentId: string) => void
  onKillAgent: (agentId: string) => void
  // Set when this run has no resident workspace (the Sprints door on a run whose
  // workspace was removed, MC-1800): its terminals live in that workspace, so
  // opening, starting, restarting, killing and per-agent runtime edits cannot
  // happen from here. The value is the plain-word reason each affected control
  // speaks; the run-level controls (add a role, role model) are unaffected
  // because they write to the run, not to the workspace.
  terminalActionsUnavailable?: string
  // Set when even the run-level roster cannot be changed from here — a run from
  // before run-level roles keeps its team in the workspace record, so with that
  // workspace closed there is nothing to write. Also the plain-word reason.
  roleConfigUnavailable?: string
}) {
  const [menu, setMenu] = useState<RosterMenuTarget | null>(null)
  const [addRoleOpen, setAddRoleOpen] = useState(false)
  const [addAgentOpen, setAddAgentOpen] = useState(false)

  const menuAgent = menu ? roster.find((agent) => agent.id === menu.agentId) ?? null : null

  // An unavailable control still names itself, then says why — the same shape
  // the Sprints bar's disabled "Open agents" uses, so the two surfaces explain
  // the closed workspace the same way.
  const labelWithReason = (action: string, reason: string | undefined): string | undefined =>
    reason ? `${action} — unavailable: ${reason}` : undefined
  const unavailableLabel = (action: string): string | undefined =>
    labelWithReason(action, terminalActionsUnavailable)

  // Friendly label for a model id, resolved through the CLI catalog; falls
  // back to the raw id so an uncataloged model still reads truthfully.
  const modelLabelFor = (cli: AgentCli | undefined, model: string | null | undefined): string | null => {
    if (!model) return null
    const catalog = cliOptions.find((option) => option.value === cli)?.modelSelection
    return catalog?.options.find((entry) => entry.id === model)?.label ?? model
  }
  const cliLabelFor = (cli: AgentCli | undefined): string | null =>
    cli ? cliOptions.find((option) => option.value === cli)?.label ?? cli : null

  const describeEntry = (agent: SprintEngineAgentRosterItem): RosterEntryDescriptor => {
    const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
    const hasLiveTerminal = isAgentTerminalLive(agent.id)
    const agentState = agents[agent.id]
    const spawnPending = Boolean(agentState?.cliStartRequested) && !hasLiveTerminal
    const statusKey = runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')
    const statusLabel = spawnPending ? 'Starting' : runtimeStatusLabel(statusKey)
    const displayName = agentState?.name?.trim() || agent.label
    const record = sprintEngineState.sprintEngineAgents[agent.id]
    const lastOwnedTaskId = record?.lastOwnedTaskId ?? null
    const activityTaskId = runtime?.currentTaskId ?? lastOwnedTaskId
    const activityTask: SprintEngineTask | undefined = activityTaskId
      ? sprintEngineState.tasks.find((entry) => entry.id === activityTaskId)
      : undefined
    const activity = activityTaskId
      ? `${activityTaskId}${activityTask?.title ? ` · ${activityTask.title}` : ''}`
      : statusLabel

    // Launched-vs-configured divergence. The record's cli/cliModel are the
    // reconciled config (re-stamped from roleRuntimes each projection read);
    // cliLaunchedRuntime is what the running session actually started with.
    // Only a live session can meaningfully diverge; without a launch stamp
    // (pre-MC-1516 sessions) we say nothing rather than guess.
    const launched = agentState?.cliLaunchedRuntime
    const launchedModel = launched?.model ?? null
    const configModel = agentState?.cliModel ?? null
    const cliDiffers = Boolean(launched?.cli && agentState?.cli && launched.cli !== agentState.cli)
    const diverged = hasLiveTerminal && Boolean(launched) && (cliDiffers || launchedModel !== configModel)
    const divergedFrom = diverged
      ? cliDiffers
        ? cliLabelFor(launched?.cli)
        : modelLabelFor(launched?.cli ?? agentState?.cli, launchedModel) ?? `${cliLabelFor(launched?.cli ?? agentState?.cli) ?? ''} default`.trim()
      : null

    return {
      agent,
      runtime,
      hasLiveTerminal,
      spawnPending,
      resumable: !hasLiveTerminal && willResumeAgent(agent.id),
      statusKey,
      statusLabel,
      displayName,
      activity,
      divergedFrom,
      // Never interrupt work: the restart offer is actionable only while the
      // diverged session is not doing anything (idle between claims).
      offerRestart:
        diverged && statusKey !== 'running' && statusKey !== 'planning' && statusKey !== 'needs_input',
    }
  }

  // Group roster entries by role, newest first: the roster arrives ascending,
  // reversing each group puts the most recently minted session on top with the
  // persistent bare `<role>` id settling to the stable bottom.
  const entriesByRole = new Map<SprintEngineRoleId, SprintEngineAgentRosterItem[]>()
  for (const agent of roster) {
    const list = entriesByRole.get(agent.role)
    if (list) list.push(agent)
    else entriesByRole.set(agent.role, [agent])
  }
  for (const list of entriesByRole.values()) list.reverse()

  // Sections to show: every enabled (configured) role plus any role that has
  // entries, in canonical role order. Prefer the projected `configuredRoles`
  // (the roles the user actually turned on): under the lazy roster only the
  // architect is seated at start, so a configured reviewer would otherwise be
  // invisible until it spawns. Legacy runs fall back to the seated census.
  const optionByRole = new Map(addMemberOptions.map((option) => [option.role, option]))
  const enabledRoles = new Set(
    sprintEngineState.configuredRoles && sprintEngineState.configuredRoles.length > 0
      ? sprintEngineState.configuredRoles
      : sprintEngineEnabledRoles(sprintEngineState.roleCounts),
  )
  const rolePriority = (role: SprintEngineRoleId): number => {
    const index = sprintEngineRoleOrder.indexOf(role as SprintEngineRole)
    return index >= 0 ? index : sprintEngineRoleOrder.length
  }
  const roleOrder = [...new Set<SprintEngineRoleId>([...enabledRoles, ...entriesByRole.keys()])].sort(
    (a, b) => rolePriority(a) - rolePriority(b) || a.localeCompare(b),
  )

  const roleLabelFor = (role: SprintEngineRoleId): string =>
    optionByRole.get(role)?.label ?? getSprintEngineRoleLabel(role)

  // Header census: how many agents are actually working, and how many roles the
  // run configures. Both derive from the workers view + configuredRoles — never
  // a headcount of durable seats.
  const allDescriptors = roster.map(describeEntry)
  const workingCount = allDescriptors.filter(
    (entry) => entry.statusKey === 'running' || entry.statusKey === 'planning',
  ).length
  const configuredRoleCount = enabledRoles.size

  // "Add a role" lists the roles the run does not yet configure; picking one
  // routes through the host's enable-role path (a genuinely new role prompts
  // the architect to revise the plan). "Add an agent" lists the configured
  // roles; picking one raises the concurrent-agent count and spawns a puller
  // for that role now.
  const addableRoleOptions = addMemberOptions.filter((option) => !enabledRoles.has(option.role))
  const configuredRoleOptions = addMemberOptions.filter((option) => enabledRoles.has(option.role))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[color:var(--bg-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-4">
        <h3 className="text-[12.5px] font-semibold text-[color:var(--text-strong)]">Agents</h3>
        <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">
          {workingCount} working · {configuredRoleCount} configured{' '}
          {configuredRoleCount === 1 ? 'role' : 'roles'}
        </span>
        <span className="flex-1" />
        {addableRoleOptions.length > 0 && roleConfigUnavailable ? (
          <OutlineButton size="xs" disabled aria-label={labelWithReason('Add a role', roleConfigUnavailable)}>
            <span aria-hidden="true">＋</span> Add a role
          </OutlineButton>
        ) : addableRoleOptions.length > 0 ? (
          <Popover
            open={addRoleOpen}
            onOpenChange={setAddRoleOpen}
            ariaLabel="Add a role"
            popupRole="menu"
            placement="bottom-end"
            surfaceClassName="w-[240px] p-1 text-[12px]"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <OutlineButton ref={ref} size="xs" onClick={togglePopover} {...triggerProps}>
                <span aria-hidden="true">＋</span> Add a role
              </OutlineButton>
            )}
          >
            <div role="none">
              {addableRoleOptions.map((option) => (
                <MenuItem
                  key={option.role}
                  onClick={() => {
                    onEnableRole(option.role as SprintEngineRole)
                    setAddRoleOpen(false)
                  }}
                >
                  {option.label}
                </MenuItem>
              ))}
            </div>
          </Popover>
        ) : null}
        {configuredRoleOptions.length > 0 && terminalActionsUnavailable ? (
          // Both halves of "Add an agent" — raising the run's concurrent-agent
          // count and starting the agent — live in the workspace, so with none
          // resident the control says so instead of opening a menu that cannot
          // finish what it starts.
          <OutlineButton size="xs" disabled aria-label={unavailableLabel('Add an agent')}>
            <span aria-hidden="true">＋</span> Add an agent
          </OutlineButton>
        ) : configuredRoleOptions.length > 0 ? (
          <Popover
            open={addAgentOpen}
            onOpenChange={setAddAgentOpen}
            ariaLabel="Add an agent"
            popupRole="menu"
            placement="bottom-end"
            surfaceClassName="w-[240px] p-1 text-[12px]"
            renderTrigger={({ ref, triggerProps, togglePopover }) => (
              <OutlineButton ref={ref} size="xs" onClick={togglePopover} {...triggerProps}>
                <span aria-hidden="true">＋</span> Add an agent
              </OutlineButton>
            )}
          >
            <div role="none">
              <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold text-[color:var(--text-subtle)]">
                Start another agent for
              </p>
              {configuredRoleOptions.map((option) => (
                <MenuItem
                  key={option.role}
                  onClick={() => {
                    onAddAgent(option.role as SprintEngineRole)
                    setAddAgentOpen(false)
                  }}
                >
                  {option.label}
                </MenuItem>
              ))}
            </div>
          </Popover>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {roleOrder.length === 0 ? (
          <div className="px-4 py-6 text-[12px] leading-5 text-[color:var(--text-subtle)]">
            No roles configured yet. Add a role to staff this run.
          </div>
        ) : (
          roleOrder.map((role) => {
            const entries = entriesByRole.get(role) ?? []
            const descriptors = entries.map(describeEntry)
            const liveCount = descriptors.filter((entry) => entry.hasLiveTerminal).length
            const roleLabel = roleLabelFor(role)
            const census =
              entries.length === 0 ? 'None running' : `${liveCount} of ${entries.length} active`
            const bandCli = roleRuntimeCli(role)
            return (
              <section key={role} aria-label={roleLabel}>
                {/* Role band: the role-level facts, with the model editable in
                    place — the property you see is the control that edits it. */}
                <div className="flex h-[34px] items-center gap-2 border-b border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-4 first:border-t-0">
                  <span className="text-[11.5px] font-semibold text-[color:var(--text-default)]">
                    {roleLabel}
                  </span>
                  <span className="text-[10px] tabular-nums text-[color:var(--text-subtle)]">{census}</span>
                  <span className="flex-1" />
                  <CliModelPickerButton
                    ariaLabel={`${roleLabel} model`}
                    options={cliOptions}
                    cli={bandCli}
                    quiet
                    effectiveModelFor={(cli) => roleRuntimeModel(role, cli)}
                    onSelectCli={(cli) => onSelectRoleCli(role, cli)}
                    onSelectModel={(cli, model) => onSelectRoleModel(role, cli, model)}
                  />
                </div>

                {entries.length === 0 ? (
                  <p className="px-4 py-2 text-[11px] text-[color:var(--text-subtle)]">
                    No agents yet — one starts when this role has work.
                  </p>
                ) : (
                  <ol aria-label={`${roleLabel} agents`}>
                    {descriptors.map((descriptor) => renderAgentRow(descriptor))}
                  </ol>
                )}
              </section>
            )
          })
        )}
      </div>

      {menu && menuAgent ? (() => {
        const live = isAgentTerminalLive(menuAgent.id)
        const agentState = agents[menuAgent.id]
        const pending = Boolean(agentState?.cliStartRequested) && !live
        const resumable = !live && willResumeAgent(menuAgent.id)
        const displayName = agentState?.name?.trim() || menuAgent.label
        const close = () => setMenu(null)

        // Right-click fast path: the per-agent CLI/model picker on its own.
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
              label="CLI / model (this agent)"
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

  // One seat: a single-line row on the same left edge as its band. Status,
  // name, activity; the right side carries the divergence label when the live
  // session still runs a pre-edit runtime, the actionable-now action (Spawn /
  // Resume / Restart) persistently, and hover reveals Open + the ⋮ menu.
  function renderAgentRow(descriptor: RosterEntryDescriptor): React.ReactNode {
    const {
      agent,
      spawnPending,
      resumable,
      statusKey,
      statusLabel,
      displayName,
      activity,
      divergedFrom,
      offerRestart,
    } = descriptor
    const hasLiveTerminal = descriptor.hasLiveTerminal
    const lifecycle = rosterLifecycle(statusKey, spawnPending)
    return (
      <li key={agent.id}>
        <div
          onContextMenu={(event) => {
            // The right-click fast path edits this agent's runtime on the
            // workspace record; with no workspace there is nothing to write, so
            // the row opens no menu at all rather than a dead one.
            if (terminalActionsUnavailable) return
            event.preventDefault()
            setMenu({ kind: 'picker', agentId: agent.id, x: event.clientX, y: event.clientY })
          }}
          className="group flex min-h-[34px] w-full min-w-0 items-center gap-2.5 px-4 transition-colors hover:bg-[color:var(--bg-hover)]"
        >
          <span className="flex w-3 shrink-0 items-center justify-center">
            {lifecycle ? (
              lifecycle.kind === 'dot' ? (
                // Decorative: the visually-hidden status text below is the
                // single spoken source for the state.
                <StatusDot tone={lifecycle.tone} pulse={lifecycle.pulse} />
              ) : (
                <Tooltip
                  content={rosterStatusTooltip(statusKey, statusLabel)}
                  wrapperClassName="inline-flex"
                >
                  <LifecycleGlyph state={lifecycle.state} live={lifecycle.live} />
                </Tooltip>
              )
            ) : (
              <span
                aria-hidden="true"
                className="h-[7px] w-[7px] rounded-full border border-[color:var(--text-subtle)]"
              />
            )}
          </span>
          <span className="w-[148px] shrink-0 truncate text-[12.5px] font-medium text-[color:var(--text-default)]">
            {displayName}
          </span>
          <span className="sr-only">{statusLabel}</span>
          <TruncatedText
            as="span"
            text={activity}
            className="min-w-0 flex-1 text-[11.5px] text-[color:var(--text-subtle)]"
          />
          <span className="flex shrink-0 items-center gap-2">
            {divergedFrom ? (
              <span
                className="font-mono text-[10px] text-[color:var(--text-subtle)]"
                title={`This session is still running ${divergedFrom}; it switches when it next starts.`}
              >
                on {divergedFrom}
              </span>
            ) : null}
            {offerRestart && !terminalActionsUnavailable ? (
              <OutlineButton
                size="xs"
                onClick={() => onRestartAgent(agent.id)}
                aria-label={`Restart ${displayName} on the new model`}
              >
                Restart
              </OutlineButton>
            ) : null}
            {hasLiveTerminal ? (
              <GhostButton
                size="xs"
                onClick={() => onOpenAgent(agent.id)}
                disabled={Boolean(terminalActionsUnavailable)}
                aria-label={unavailableLabel(`Open ${displayName} terminal`) ?? `Open ${displayName} terminal`}
                // Unavailable, the action stays visible: a control that only
                // appears on hover cannot explain why it is not there.
                className={
                  terminalActionsUnavailable
                    ? ''
                    : 'opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100'
                }
              >
                Open
              </GhostButton>
            ) : (
              // A seat that is actionable right now keeps its action visible
              // without hover.
              <OutlineButton
                size="xs"
                onClick={() => onSpawnAgent(agent.id)}
                disabled={spawnPending || Boolean(terminalActionsUnavailable)}
                aria-label={
                  spawnPending
                    ? `${displayName} is starting`
                    : resumable
                      ? unavailableLabel(`Resume ${displayName}`) ?? `Resume ${displayName}`
                      : unavailableLabel(`Spawn ${displayName}`) ?? `Spawn ${displayName}`
                }
              >
                {spawnPending ? 'Starting…' : resumable ? 'Resume' : 'Spawn'}
              </OutlineButton>
            )}
            {/* Every entry in the ⋮ menu — open, spawn, restart, kill, and this
                agent's own runtime — needs the workspace. With none, the menu
                would hold nothing operable, so the row does not offer it. */}
            {terminalActionsUnavailable ? null : (
              <button
                type="button"
                aria-label={`${displayName} actions`}
                aria-haspopup="menu"
                onClick={(event) => {
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMenu({ kind: 'actions', agentId: agent.id, x: rect.right, y: rect.bottom })
                }}
                className="interactive inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--text-disabled)] opacity-0 transition-opacity hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] group-focus-within:opacity-100 group-hover:opacity-100"
              >
                <svg viewBox="0 0 16 16" className="icon-sm" fill="currentColor" aria-hidden="true">
                  <circle cx="8" cy="3.4" r="1.3" />
                  <circle cx="8" cy="8" r="1.3" />
                  <circle cx="8" cy="12.6" r="1.3" />
                </svg>
              </button>
            )}
          </span>
        </div>
      </li>
    )
  }
}
