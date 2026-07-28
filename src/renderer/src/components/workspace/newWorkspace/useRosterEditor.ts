// The roster editor's state, lifted out of NewWorkspacePanel (MC-1879) so more
// than one surface can drive `SprintEngineRosterPanel`. The panel itself is
// already fully controlled and presentational; everything behind it lived
// inline in a ~3500-line component and was reachable from nowhere else.
//
// This is a PURE MOVE. It ships no behaviour change: every setter keeps the
// order and the side effects it had inline, because the wizard is the app's
// most load-bearing flow and a subtle regression here is expensive.
//
// BOUNDARY (deliberate, so the hook stays small): this hook is about EDITING a
// roster. The wizard's create-time derivations — `sprintEnginePlainAgents`,
// `sprintEngineEffectiveCreateRoleCounts`, `sprintEngineEffectiveVisibleRoleCounts`
// — are about LAUNCHING a run and stay in the panel. Horizon does not need them.
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoleReasoningOverrides,
  SprintEngineRoleRegistry,
  SprintEngineRoster,
  SprintEngineRosterMode,
} from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  applyUserDisabledSprintEngineRoleCounts,
  buildSprintEngineRoleRegistry,
  getUserDisabledSprintEngineRoleIds,
} from '../../../utils/sprintengine'
import { sprintEngineRosterRoleFloor } from '../../../utils/sprintengineRoleOptions'
import {
  resolveAvailableAgentCli,
  type AgentCliCatalogOption,
} from './cliRuntimeOptions'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  NO_ROLES_ROSTER_ID,
  isNoRolesRosterRef,
  pruneSprintEngineRoleCliDefaults,
  pruneSprintEngineRoleModelOverrides,
  resolveInitialSprintEngineRoster,
  resolveSprintEngineRosterMode,
  sprintEngineRosterMatches,
} from './savedRosters'

export type RosterEditorOptions = {
  /** Seed the editor on a specific roster (id or the built-in). */
  initialRosterId?: string | null
  /** An existing run's roster is membership-locked; runtimes stay editable. */
  rosterDisabled?: boolean
  /**
   * The installed-CLI catalog. Passed in rather than computed here because the
   * wizard shares one catalog across the roster, guided-brief and review flows;
   * a second copy would drift.
   */
  cliOptions: AgentCliCatalogOption[]
  /** 'ready' once CLI detection is trustworthy enough to remap defaults. */
  cliAvailabilityStatus: string
  /** Project root the role registry is read from; null = no registry. */
  workspaceRoot?: string | null
  /**
   * True while an EXISTING run is loaded. Existing runs render canonical
   * projection state, so user settings must not mask roles already configured
   * on them, and editing the roster detaches from the run.
   */
  hasExistingRun?: boolean
  /** Called when an edit means "this is no longer the existing run's roster". */
  onDetachFromExistingRun?: () => void
  /** Called with the role whose CLI changed, so the panel can drop per-agent overrides. */
  onRoleCliChanged?: (role: SprintEngineRoleId) => void
}

export type RosterEditorResult = {
  // --- The props SprintEngineRosterPanel consumes, verbatim ---------------
  rosterMode: SprintEngineRosterMode
  onChangeRosterMode: (mode: SprintEngineRosterMode) => void
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
  /**
   * Per-role reasoning-effort level (MC-1885's producer). Wizard-session state
   * only: a level does NOT ride a saved roster preset (see the note on
   * SprintEngineSavedRoster), so this map starts empty on every mount and is
   * cleared when a preset is loaded.
   */
  roleReasoningOverrides: SprintEngineRoleReasoningOverrides
  onSetRoleCount: (role: SprintEngineRoleId, count: number) => void
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  onSetRoleModel: (role: SprintEngineRoleId, model: string | null) => void
  onSetRoleReasoning: (role: SprintEngineRoleId, reasoning: string | null) => void
  cliOptions: AgentCliCatalogOption[]
  registry: SprintEngineRoleRegistry | null
  registryStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  disabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
  rosterDisabled: boolean
  rosters: SprintEngineRoster[]
  selectedRosterId: string | null
  selectedRosterDirty: boolean
  onSelectRoster: (id: string | null) => void
  onSaveRoster: (name: string) => void
  onUpdateRoster: (id: string, name: string) => void
  onRenameRoster: (id: string, name: string) => void
  onDeleteRoster: (id: string) => void
  poolAgentCount: number
  onChangePoolAgentCount: (value: number) => void

  // --- Escape hatches the wizard's own create path still needs ------------
  /** The raw stored counts, BEFORE user-disabled roles are masked out. */
  rawRoleCounts: SprintEngineRoleCounts
  useSpecialistRoles: boolean
  setRoleCounts: React.Dispatch<React.SetStateAction<SprintEngineRoleCounts>>
  setRoleCliDefaults: React.Dispatch<React.SetStateAction<Required<SprintEngineRoleCliDefaults>>>
  setRoleModelOverrides: React.Dispatch<React.SetStateAction<SprintEngineRoleModelOverrides>>
  setSelectedRosterId: React.Dispatch<React.SetStateAction<string | null>>
}

function cloneRoleCounts(roleCounts: SprintEngineRoleCounts): SprintEngineRoleCounts {
  return { ...roleCounts }
}

// Clamp every role's CLI default to an installed agent CLI. The catalog passed
// in is already availability-filtered, so resolveAvailableAgentCli remaps any
// role still pointing at an uninstalled CLI (e.g. a saved roster's Claude Code
// on a Codex-only machine) to an installed one. Returns the same object
// reference when nothing changes so it is a no-op inside setState (no render
// thrash). Lives here rather than in the wizard because the roster editor is
// its primary consumer; the wizard imports it for the guided-brief defaults.
export function remapRoleCliDefaultsToAvailable<T extends Record<string, AgentCli | undefined>>(
  defaults: T,
  catalog: AgentCliCatalogOption[],
): T {
  if (catalog.length === 0) return defaults
  let changed = false
  const next = { ...defaults }
  for (const role of Object.keys(defaults) as Array<keyof T>) {
    const current = defaults[role]
    if (current === undefined) continue
    const resolved = resolveAvailableAgentCli(current, catalog, current) as T[keyof T]
    if (resolved !== current) {
      next[role] = resolved
      changed = true
    }
  }
  return changed ? next : defaults
}

// A saved roster stores only the roles it staffs; layer it over the full
// default map so every known role keeps a valid CLI.
function roleCliDefaultsFromRoster(
  roster: { roleCliDefaults?: SprintEngineRoleCliDefaults },
): Required<SprintEngineRoleCliDefaults> {
  return {
    ...DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
    ...(roster.roleCliDefaults ?? {}),
  } as Required<SprintEngineRoleCliDefaults>
}

export function useRosterEditor(options: RosterEditorOptions): RosterEditorResult {
  const {
    cliOptions,
    cliAvailabilityStatus,
    workspaceRoot,
    hasExistingRun = false,
    onDetachFromExistingRun,
    onRoleCliChanged,
  } = options

  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  const saveSprintEngineRoster = useWorkspaceStore((s) => s.saveSprintEngineRoster)
  const renameSprintEngineRoster = useWorkspaceStore((s) => s.renameSprintEngineRoster)
  const deleteSprintEngineRoster = useWorkspaceStore((s) => s.deleteSprintEngineRoster)
  const setSprintEngineLastSelectedRoster = useWorkspaceStore((s) => s.setSprintEngineLastSelectedRoster)

  const rosters = useMemo(
    () => sprintEngineRoleSettings?.savedRosters ?? [],
    [sprintEngineRoleSettings],
  )

  // Seeded ONCE, at mount, exactly as the wizard did: the resolved roster is a
  // starting point, not a live binding, so later store writes never yank rows
  // out from under an in-progress edit.
  const [initial] = useState(() => resolveInitialSprintEngineRoster({
    savedRosters: sprintEngineRoleSettings?.savedRosters ?? [],
    lastSelectedRosterId: sprintEngineRoleSettings?.lastSelectedRosterId,
    savedRoster: sprintEngineRoleSettings?.savedRoster ?? null,
    defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
    defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
    ...(options.initialRosterId !== undefined ? { explicitRosterRef: options.initialRosterId } : {}),
  }))

  const [roleCounts, setRoleCounts] = useState<SprintEngineRoleCounts>(
    () => cloneRoleCounts(initial.roleCounts),
  )
  const [roleCliDefaults, setRoleCliDefaults] = useState<Required<SprintEngineRoleCliDefaults>>(
    () => ({ ...initial.roleCliDefaults }),
  )
  const [roleModelOverrides, setRoleModelOverrides] = useState<SprintEngineRoleModelOverrides>(
    () => ({ ...initial.roleModelOverrides }),
  )
  // Effort levels are wizard-session state, never seeded from a roster: a saved
  // preset does not carry one (ruling 2026-07-28 — that is a store-schema
  // change, and this run's schema numbers are pinned to 69 and 70).
  const [roleReasoningOverrides, setRoleReasoningOverrides] = useState<SprintEngineRoleReasoningOverrides>({})
  const [selectedRosterId, setSelectedRosterId] = useState<string | null>(() => initial.selectedRosterId)
  const [useSpecialistRoles, setUseSpecialistRoles] = useState(() => initial.mode === 'roles')
  // Run-level concurrency cap, surfaced on the roster step's pool panel.
  // Plain-agent runs default to 2, specialist runs to 3 (MC-1585).
  const [poolAgentCount, setPoolAgentCount] = useState(() => (initial.mode === 'roles' ? 3 : 2))

  const [registry, setRegistry] = useState<SprintEngineRoleRegistry | null>(null)
  const [registryStatus, setRegistryStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')

  // The formation segmented control is a projection of the one stored axis.
  const rosterMode: SprintEngineRosterMode = useSpecialistRoles ? 'roles' : 'pool'
  const onChangeRosterMode = useCallback((mode: SprintEngineRosterMode) => {
    setUseSpecialistRoles(mode === 'roles')
  }, [])

  // Existing runs render canonical projection state; user settings must not
  // hide roles already configured on them.
  const disabledRoleIds = useMemo<ReadonlySet<SprintEngineRoleId> | null>(
    () => (hasExistingRun ? null : getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings)),
    [hasExistingRun, sprintEngineRoleSettings],
  )

  const visibleRoleCounts = useMemo(
    () => (disabledRoleIds
      ? applyUserDisabledSprintEngineRoleCounts(roleCounts, disabledRoleIds)
      : roleCounts),
    [roleCounts, disabledRoleIds],
  )

  // The registry read. One fetch per workspace root — see the note on
  // duplicate mounts at the bottom of this file.
  useEffect(() => {
    let cancelled = false
    if (!workspaceRoot || typeof window.api.readSprintEngineRegistryRoles !== 'function') {
      setRegistry(null)
      setRegistryStatus(workspaceRoot ? 'unavailable' : 'idle')
      return undefined
    }
    setRegistryStatus('loading')
    void window.api.readSprintEngineRegistryRoles({ workspaceRoot, includeShadowed: true })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setRegistry(buildSprintEngineRoleRegistry(result.data))
          setRegistryStatus('ready')
        } else {
          setRegistry(null)
          setRegistryStatus('unavailable')
        }
      })
      .catch(() => {
        if (cancelled) return
        setRegistry(null)
        setRegistryStatus('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  // Once detection is trustworthy, remap any role default seeded to an
  // uninstalled CLI so creation never deploys — or even offers — a CLI the user
  // does not have. Idempotent: it returns the same reference when nothing needs
  // changing, so setState bails and this converges without looping.
  useEffect(() => {
    if (cliAvailabilityStatus !== 'ready') return
    setRoleCliDefaults((current) => remapRoleCliDefaultsToAvailable(current, cliOptions))
  }, [cliAvailabilityStatus, cliOptions])

  const onSetRoleCount = useCallback((role: SprintEngineRoleId, count: number) => {
    onDetachFromExistingRun?.()
    setRoleCliDefaults((current) => ({
      ...current,
      // Seed a newly surfaced role with an installed CLI rather than the raw
      // Claude Code default, so bumping a role count never reintroduces an
      // uninstalled agent on a machine that lacks it.
      [role]: current[role] ?? resolveAvailableAgentCli('claude-code', cliOptions, 'claude-code'),
    }))
    setRoleCounts((current) => {
      // Floor against the current counts so a planning role (architect/general)
      // can only drop to 0 while the other planner is staffed — the roster
      // never loses its last planning-capable agent. Counts are an enabled-set
      // encoding (MC-1450): every role is 0 or 1; parallelism comes from the
      // max-parallel-agents knob + mint-on-demand, not headcounts.
      const min = sprintEngineRosterRoleFloor(role, current)
      return {
        ...current,
        [role]: Math.max(min, Math.min(1, Math.floor(count))),
      }
    })
  }, [cliOptions, onDetachFromExistingRun])

  const onSetRoleCli = useCallback((role: SprintEngineRoleId, cli: AgentCli) => {
    setRoleCliDefaults((current) => ({ ...current, [role]: cli }))
    // A model picked for the previous CLI is meaningless on the new one; drop
    // the override so the row falls back to the new CLI's remembered default.
    setRoleModelOverrides((current) => {
      if (!(role in current)) return current
      const next = { ...current }
      delete next[role]
      return next
    })
    // Same rule for the effort level, for the same reason: levels are per-CLI
    // manifest knowledge (`ultra` exists on Codex and not on Claude Code), so a
    // level picked for the previous CLI is meaningless — and the new CLI may
    // declare no levels at all. Drop it rather than carry it across.
    setRoleReasoningOverrides((current) => {
      if (!(role in current)) return current
      const next = { ...current }
      delete next[role]
      return next
    })
    onRoleCliChanged?.(role)
  }, [onRoleCliChanged])

  const onSetRoleModel = useCallback((role: SprintEngineRoleId, model: string | null) => {
    setRoleModelOverrides((current) => ({ ...current, [role]: model }))
  }, [])

  // A level survives a model change within one CLI (the map is keyed by role,
  // not by model) and is dropped by onSetRoleCli above when the CLI changes.
  const onSetRoleReasoning = useCallback((role: SprintEngineRoleId, reasoning: string | null) => {
    setRoleReasoningOverrides((current) => ({ ...current, [role]: reasoning }))
  }, [])

  // Load a saved roster into the rows, or detach to a hand-tuned ("Custom")
  // roster when id is null.
  const onSelectRoster = useCallback((id: string | null) => {
    if (!id) {
      setSelectedRosterId(null)
      setSprintEngineLastSelectedRoster(null)
      return
    }
    // The built-in is synthetic and not in `rosters`, so it needs its own
    // branch. Selecting it means "no roster": switch to pool formation and
    // leave the specialist rows alone so switching back restores them.
    if (isNoRolesRosterRef(id)) {
      onDetachFromExistingRun?.()
      setUseSpecialistRoles(false)
      setSelectedRosterId(NO_ROLES_ROSTER_ID)
      setSprintEngineLastSelectedRoster(NO_ROLES_ROSTER_ID)
      return
    }
    const roster = rosters.find((entry) => entry.id === id)
    if (!roster) return
    onDetachFromExistingRun?.()
    setRoleModelOverrides({ ...(roster.roleModelOverrides ?? {}) })
    // Loading a preset replaces the whole runtime configuration, and a preset
    // carries no level. Clearing rather than keeping the hand-tuned levels is
    // the per-CLI drop rule again: the loaded roster may staff these roles on
    // different CLIs entirely.
    setRoleReasoningOverrides({})
    setRoleCounts(cloneRoleCounts(roster.roleCounts))
    setRoleCliDefaults(roleCliDefaultsFromRoster(roster))
    // Restore the SAVED formation rather than re-deriving it from roleCounts.
    setUseSpecialistRoles(resolveSprintEngineRosterMode(roster, true, roster.roleCounts) === 'roles')
    setSelectedRosterId(roster.id)
    setSprintEngineLastSelectedRoster(roster.id)
  }, [rosters, onDetachFromExistingRun, setSprintEngineLastSelectedRoster])

  const onSaveRoster = useCallback((name: string) => {
    const id = saveSprintEngineRoster({
      name,
      mode: rosterMode,
      roleCounts: cloneRoleCounts(visibleRoleCounts),
      roleCliDefaults: pruneSprintEngineRoleCliDefaults(visibleRoleCounts, roleCliDefaults),
      roleModelOverrides: pruneSprintEngineRoleModelOverrides(visibleRoleCounts, roleModelOverrides),
    })
    if (id) setSelectedRosterId(id)
  }, [saveSprintEngineRoster, rosterMode, visibleRoleCounts, roleCliDefaults, roleModelOverrides])

  // "Update" re-saves the current (edited) rows under the roster's existing name.
  const onUpdateRoster = useCallback((id: string, name: string) => {
    saveSprintEngineRoster({
      id,
      name,
      mode: rosterMode,
      roleCounts: cloneRoleCounts(visibleRoleCounts),
      roleCliDefaults: pruneSprintEngineRoleCliDefaults(visibleRoleCounts, roleCliDefaults),
      roleModelOverrides: pruneSprintEngineRoleModelOverrides(visibleRoleCounts, roleModelOverrides),
    })
    setSelectedRosterId(id)
  }, [saveSprintEngineRoster, rosterMode, visibleRoleCounts, roleCliDefaults, roleModelOverrides])

  // "Rename" changes only the name, leaving the saved roster intact — so
  // renaming never silently overwrites a roster with the current edited rows.
  const onRenameRoster = useCallback((id: string, name: string) => {
    renameSprintEngineRoster(id, name)
    setSelectedRosterId(id)
  }, [renameSprintEngineRoster])

  const onDeleteRoster = useCallback((id: string) => {
    deleteSprintEngineRoster(id)
    setSelectedRosterId((current) => (current === id ? null : current))
  }, [deleteSprintEngineRoster])

  // The saved roster the rows were loaded from, and whether they still match
  // it. The built-in resolves to null here — correct, since it has nothing to
  // be edited relative to, and that absence is what makes it uneditable.
  const selectedRoster = useMemo(
    () => (selectedRosterId && !isNoRolesRosterRef(selectedRosterId)
      ? rosters.find((roster) => roster.id === selectedRosterId) ?? null
      : null),
    [selectedRosterId, rosters],
  )
  // Deliberately blind to roleReasoningOverrides: a preset cannot store a level,
  // so a picked level must not make the roster read as edited — that would offer
  // an "Update" whose only effect is to drop what the user just picked.
  const selectedRosterDirty = useMemo(
    () => (selectedRoster
      ? !sprintEngineRosterMatches(
          selectedRoster,
          visibleRoleCounts,
          roleCliDefaults,
          roleModelOverrides,
          rosterMode,
        )
      : false),
    [selectedRoster, visibleRoleCounts, roleCliDefaults, roleModelOverrides, rosterMode],
  )

  return {
    rosterMode,
    onChangeRosterMode,
    roleCounts: visibleRoleCounts,
    roleCliDefaults,
    roleModelOverrides,
    roleReasoningOverrides,
    onSetRoleCount,
    onSetRoleCli,
    onSetRoleModel,
    onSetRoleReasoning,
    cliOptions,
    registry,
    registryStatus,
    disabledRoleIds,
    rosterDisabled: options.rosterDisabled ?? false,
    rosters,
    selectedRosterId,
    selectedRosterDirty,
    onSelectRoster,
    onSaveRoster,
    onUpdateRoster,
    onRenameRoster,
    onDeleteRoster,
    poolAgentCount,
    onChangePoolAgentCount: setPoolAgentCount,

    rawRoleCounts: roleCounts,
    useSpecialistRoles,
    setRoleCounts,
    setRoleCliDefaults,
    setRoleModelOverrides,
    setSelectedRosterId,
  }
}

// DUPLICATE MOUNTS: two live instances (the wizard open behind the Horizon
// roster manager) each run the registry effect, so the registry is read twice.
// That read is a cheap main-process file scan with no write side effects, and
// the two instances hold independent editing state ON PURPOSE — a modal edit
// must not mutate the rows the wizard is showing until it is saved, and the
// store is what carries a save between them. Sharing the fetch would be an
// optimisation; sharing the STATE would be a bug.
