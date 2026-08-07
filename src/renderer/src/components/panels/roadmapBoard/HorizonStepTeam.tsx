// The selected step's TEAM (MC-2066) — who will do this work — as a band in the
// Horizon detail pane, beside the step it staffs rather than a chip in the top
// bar. The plan column's row chip is the resting readout of the same fact; this
// is where the choice is made and where what it MEANS is spelled out.
//
// The split is the New sprint dialog's, because it is the same choice (MC-2062):
//   - No roles  → the step runs plain agents, so what matters is WHICH agent and
//                 how many at once.
//   - A roster  → the roster carries the agents. Its roles and their runtimes are
//                 shown; there is no second agent picker here to contradict it.
//
// `RosterMenu` is the picker, verbatim — the same menu the row chip and the
// horizon's default use, so "No roles" stays pinned first and "Manage rosters…"
// stays the one door to the editor.
//
// READOUT, not a claim: the plain-agent facts are read through the very
// resolution the launch performs (`resolveInitialSprintEngineRoster` with the
// built-in reference, and the plan-sourced launch's own concurrency default), so
// this band cannot drift from what a start actually spawns. They are not
// editable per step: the horizon file carries a step's ROSTER and nothing else,
// so a picker here would write nothing. See
// `backlog/2026-08-06-a-horizon-step-cannot-name-its-agent.md`.

import { useMemo } from 'react'

import { RoleAvatar } from '../../ui'
import { RosterMenu } from '../../backlog/RosterMenu'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  runtimeLabelFor,
  selectAgentCliCatalog,
  type RuntimeCrumbCliOption,
} from '../../workspace/newWorkspace/cliRuntimeOptions'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  NO_ROLES_ROSTER_ID,
  activeSprintEngineRoleIds,
  findSavedSprintEngineRoster,
  isNoRolesRosterRef,
  resolveInitialSprintEngineRoster,
} from '../../workspace/newWorkspace/savedRosters'
import { SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS } from '../../workspace/newWorkspace/controllers/sprintEngineController'
import { SPRINT_ENGINE_ROLELESS_KEY, getSprintEngineRoleLabel } from '../../../utils/sprintengine'
import type { SprintEngineRoleRegistry, SprintEngineRoster } from '../../../types/workspace'
import { horizonStepTeamKind, type HorizonStepRoster } from './horizonPlanModel'

export type HorizonStepTeamProps = {
  /** The step's own title, for the picker's accessible name. */
  stepTitle: string
  /** The resolved staffing of this step — label, whether the step overrode the
   *  horizon, and whether the name resolves to a saved roster. */
  roster: HorizonStepRoster
  /** The user's saved rosters (a global preference, not a horizon's). */
  rosters: ReadonlyArray<SprintEngineRoster>
  /** What this step falls back to with no override of its own. */
  inheritedLabel: string
  /** Set this step's roster; `undefined` means the built-in "No roles". */
  onSelect: (name: string | undefined) => void
  /** Clear the override so the step inherits the horizon's default again. */
  onInherit: () => void
  onManageRosters: () => void
}

export function HorizonStepTeam({
  stepTitle,
  roster,
  rosters,
  inheritedLabel,
  onSelect,
  onInherit,
  onManageRosters,
}: HorizonStepTeamProps): JSX.Element {
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const registry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)

  const cliOptions = useMemo(
    () =>
      selectAgentCliCatalog(
        pluginCatalogStatus,
        pluginCatalogEntries,
        appCliRuntimes,
        { map: cliAvailability, status: cliAvailabilityStatus },
        cliModelCatalog,
      ),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      appCliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
    ],
  )

  // The saved roster this step names, when it names one that still exists. A
  // MISSING name resolves to nothing on purpose — it must never fall through to
  // the default (the epic's standing decision: the start fails loudly instead),
  // which is why the kind is decided by the pure rule rather than here.
  const savedRoster = isNoRolesRosterRef(roster.label)
    ? null
    : findSavedSprintEngineRoster(rosters, roster.label)
  const kind = horizonStepTeamKind(roster, savedRoster !== null)

  // What a "No roles" step actually launches on, resolved the way the launch
  // resolves it (`resolveRequestedRoster`'s built-in branch) rather than restated
  // as a literal here.
  const plainAgentCli = useMemo(
    () =>
      resolveInitialSprintEngineRoster({
        savedRosters: [],
        lastSelectedRosterId: null,
        savedRoster: null,
        defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
        defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
        explicitRosterRef: NO_ROLES_ROSTER_ID,
      }).roleCliDefaults[SPRINT_ENGINE_ROLELESS_KEY],
    [],
  )

  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-[5px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-meta text-[color:var(--text-muted)]">Team</span>
        {/* The tier as a WORD, from `overridden` — the same source of truth the
            row chip's border comes from, never the label, so a step that picks
            the roster the horizon already uses still reads as its own choice. */}
        <span className="min-w-0 truncate text-micro text-[color:var(--text-subtle)]">
          {roster.overridden ? 'set for this step' : 'from this horizon'}
        </span>
        <span className="ml-auto shrink-0">
          <RosterMenu
            rosters={rosters}
            selectedName={roster.label}
            ariaLabel={`Team for ${stepTitle}`}
            inherit={{
              selected: !roster.overridden,
              resolvedLabel: inheritedLabel,
              onChoose: onInherit,
            }}
            onSelect={onSelect}
            onManageRosters={onManageRosters}
          />
        </span>
      </div>

      {kind === 'missing' ? (
        // Loud, and it says what happens: a named roster that no longer exists
        // fails the step's start rather than quietly staffing something else.
        <p className="text-micro leading-4 text-[color:var(--tone-warn)]">
          “{roster.label}” is not one of your saved rosters, so this step cannot start. Pick a
          team, or recreate the roster under “Manage rosters…”.
        </p>
      ) : kind === 'plain_agents' ? (
        <PlainAgentsSummary cliLabel={runtimeLabelFor(plainAgentCli, undefined, cliOptions)} />
      ) : savedRoster ? (
        <RosterSummary roster={savedRoster} registry={registry} cliOptions={cliOptions} />
      ) : null}
    </div>
  )
}

// No roles: there is no role list to show, so what the reader needs is which
// agent runs the work and how many of them run at once. Both are the launch's
// own values, stated — a horizon step cannot yet choose either.
function PlainAgentsSummary({ cliLabel }: { cliLabel: string | null }): JSX.Element {
  return (
    <p className="text-micro leading-4 text-[color:var(--text-muted)]">
      {/* The picker beside this already names the team, so the line says what
          the choice MEANS and never repeats "No roles" back. */}
      One agent per task, up to {SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS} at once
      {/* No runtime resolved is not a runtime we can name: the sentence stops
          rather than inventing one. */}
      {cliLabel ? (
        <>
          , on <span className="text-[color:var(--text-default)]">{cliLabel}</span>
        </>
      ) : null}
      .
    </p>
  )
}

// A roster: the roster carries the agents, so its staffed roles and the runtime
// each one runs are the whole answer.
function RosterSummary({
  roster,
  registry,
  cliOptions,
}: {
  roster: SprintEngineRoster
  registry: SprintEngineRoleRegistry | null
  cliOptions: ReadonlyArray<RuntimeCrumbCliOption>
}): JSX.Element {
  const roles = activeSprintEngineRoleIds(roster.roleCounts)
  if (roles.length === 0) {
    return (
      <p className="text-micro leading-4 text-[color:var(--tone-warn)]">
        “{roster.name}” staffs no roles, so this step has nobody to run it.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {roles.map((role) => {
        // A role with no CLI of its own shows none rather than a guess — the
        // roster's own default is the fact, and absent is absent.
        const runtime = runtimeLabelFor(
          roster.roleCliDefaults[role],
          roster.roleModelOverrides?.[role],
          cliOptions,
        )
        return (
          <span key={role} className="flex items-center gap-2 text-micro">
            <RoleAvatar role={role} registry={registry} size="xs" ariaLabel="" />
            <span className="min-w-0 flex-1 truncate text-[color:var(--text-default)]">
              {getSprintEngineRoleLabel(role, registry)}
            </span>
            {runtime ? (
              <span className="max-w-[10rem] shrink-0 truncate font-mono text-[color:var(--text-subtle)]">
                {runtime}
              </span>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
