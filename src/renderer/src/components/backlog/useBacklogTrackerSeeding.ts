import { useCallback, useEffect, useMemo, useState } from 'react'
import { composeIssueMarkdown, issueSprintGoal } from '../../../../shared/tracker/issue-markdown'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { sprintEngineCoordinatorSeatForRoleCounts, sprintEngineRoleKey } from '../../utils/sprintengine'
import { backlogIssueLinkIndex } from './backlogTrackerPickerModel'
import { startTrackerIssueSprint } from '../../utils/sprintengineWorkspaceCreation'
import { rendererSprintEngineWorkspaceCreationPort } from '../../utils/sprintengineWorkspaceCreationPorts'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  resolveInitialSprintEngineRoster,
  sprintEngineLaunchRoleCounts,
} from '../workspace/newWorkspace/savedRosters'
import { SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS } from '../workspace/newWorkspace/controllers/sprintEngineController'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../utils/sprintengineAutomationLifecycle'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import type { NormalizedIssue, RedactedTrackerConnection } from '../../../../shared/electron-api'
import type { BacklogItem } from '../../utils/backlog'

// Which tracker connection's search drawer is open, and whether it is sliding
// out or in. Held above the drawer component so its close animation survives a
// close (the drawer stays mounted until it finishes).
export type TrackerPickerState = { connectionId: string; open: boolean } | null

export type StartSprintResult = { ok: true } | { ok: false; error: string }

export type BacklogTrackerSeeding = {
  trackerConnections: RedactedTrackerConnection[]
  trackerPicker: TrackerPickerState
  setTrackerPicker: (next: TrackerPickerState) => void
  closeTrackerPicker: () => void
  issueLinkIndex: ReturnType<typeof backlogIssueLinkIndex>
  startSprintFromTrackerIssue: (issue: NormalizedIssue) => Promise<StartSprintResult>
}

// Tracker seeding for the Backlog panel: the "Add from tracker" drawer state and
// the one-step "Start sprint" flow that materializes a tracker issue into a proxy
// item and starts a plan-sourced sprint from it. Extracted from BacklogPanel so
// the tracker seam (T7/MC-1637 → MC-1639) lives as one cohesive unit rather than
// threaded through the 3k-line panel body. Behavior is unchanged: it composes the
// same existing seams (materialize → shared plan-sourced creation → execution
// link), never a bespoke pipeline.
export function useBacklogTrackerSeeding(params: {
  items: BacklogItem[]
  folderPath: string | null
}): BacklogTrackerSeeding {
  const { items, folderPath } = params

  // Connected trackers (redacted; no secret), for the "Add from tracker" entry
  // point (T7 / MC-1637). Empty by default: a backlog with zero tracker
  // connections shows nothing new, so the toolbar stays byte-identical to today
  // (zero-connection invariance). Re-fetched on window focus so a connection
  // added in Settings appears without remounting the panel.
  const [trackerConnections, setTrackerConnections] = useState<RedactedTrackerConnection[]>([])
  const refreshTrackerConnections = useCallback(async () => {
    const result = await window.api.trackerListConnections()
    setTrackerConnections(result.ok ? result.connections : [])
  }, [])
  useEffect(() => {
    void refreshTrackerConnections()
    const onFocus = (): void => void refreshTrackerConnections()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshTrackerConnections])

  const [trackerPicker, setTrackerPicker] = useState<TrackerPickerState>(null)
  const closeTrackerPicker = useCallback(
    () => setTrackerPicker((prev) => (prev ? { ...prev, open: false } : null)),
    [],
  )

  // `${provider}:${externalId}` for every issue already in the backlog, so the
  // tracker picker can dim + lock a row for an issue that is already a proxy
  // item (AC: "already in the backlog renders dimmed and non-selectable").
  const issueLinkIndex = useMemo(() => backlogIssueLinkIndex(items), [items])

  // One-step "Start sprint" from a tracker search row (mockup §2, MC-1639): a
  // single action that materializes the issue, then starts a plan-sourced sprint
  // from its fresh description + comments and records the run link — the
  // identical end-state to adding it and running a sprint in two steps. It
  // composes existing seams (T6 materialize → shared plan-sourced creation →
  // execution link), never a bespoke pipeline (plan D6). The saved roster is the
  // user's own configuration; a headless start never invents one.
  const startSprintFromTrackerIssue = useCallback(
    async (issue: NormalizedIssue): Promise<StartSprintResult> => {
      if (!folderPath) return { ok: false, error: 'Open a project folder first.' }
      try {
        // 1. Re-fetch the issue so the architect plans against what the tracker
        // says NOW — body and comment thread included, since acceptance criteria
        // usually live in the comments rather than the description.
        const fresh = await window.api.trackerFetchIssue({
          connectionId: issue.connectionId,
          externalId: issue.externalId,
        })
        if (!fresh.ok) return { ok: false, error: fresh.error.message }
        const current = fresh.issue
        const capturedAt = new Date().toISOString()

        // 2. Resolve the user's saved roster (never invents a roster) + auto-run mode.
        const store = useWorkspaceStore.getState()
        const roleSettings = store.appSettings.sprintEngineRoleSettings
        const roster = resolveInitialSprintEngineRoster({
          savedRosters: roleSettings?.savedRosters ?? [],
          lastSelectedRosterId: roleSettings?.lastSelectedRosterId ?? null,
          savedRoster: roleSettings?.savedRoster ?? null,
          defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
          defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
        })
        const launchRoleCounts = sprintEngineLaunchRoleCounts(roster.selectedRosterId, roster.roleCounts)
        const automationMode = sprintEngineAutomationModeForRunOptions({
          startRunner: true,
          autoApproveArtifacts: false,
        })

        // 3. Create the run. The issue markdown lands in the run's own gitignored
        // directory — nothing is written into `backlog/`, and there is no scan,
        // no lookup and no proxy item anywhere in this path.
        const result = await startTrackerIssueSprint({
          rootPath: folderPath,
          baseTeamName: slugifySprintEngineName(current.nativeKey || issue.nativeKey || 'sprint'),
          goal: issueSprintGoal(current),
          sourceContent: composeIssueMarkdown(current, { capturedAt }),
          issue: {
            provider: current.provider,
            connectionId: current.connectionId,
            externalId: current.externalId,
            nativeKey: current.nativeKey,
            url: current.url,
            capturedAt,
          },
          sourcePlanKind: 'unknown',
          // The no-roles/roster selection decides staffing here too. This is
          // the THIRD caller that resolves a roster and must honor the
          // selection it gets back; the other two are sprint.create's
          // goal-sourced and plan-sourced paths. Without this, a tracker-seeded
          // sprint on a fresh install would resolve to "No roles" and then
          // launch the specialist defaults anyway, seating an architect.
          roleCounts: launchRoleCounts,
          roleCliDefaults: roster.roleCliDefaults,
          roleModelOverrides: roster.roleModelOverrides,
          initialSpawnRoles: [sprintEngineRoleKey(sprintEngineCoordinatorSeatForRoleCounts(launchRoleCounts).role)],
          sprintEngineAutoState: {
            ...sprintEngineAutomationInitialStateForMode(automationMode),
            cliPermissionPreset: 'manual',
            maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
          },
          // Null → addWorkspace places the run in the current window (falls back to
          // the active workspace's window, then primary).
          workspaceWindowId: null,
          pathExists: window.api.pathExists,
          // `ensureDir(dir, '')` joins to `dir` itself and mkdirs it recursively —
          // the run directory does not exist until creation runs.
          ensureDirectory: async (path) => {
            await window.api.ensureDir(path, '')
          },
          writeFile: window.api.writefile,
          initializeSprintEngineState: window.api.initializeSprintEngineState,
          workspace: rendererSprintEngineWorkspaceCreationPort,
        })
        if (!result.ok) return { ok: false, error: result.message }
        return { ok: true }
      } catch (error) {
        // Failure-isolated: a thrown IPC/creation error becomes a visible result,
        // never a stuck "starting" row or an unhandled rejection.
        return { ok: false, error: error instanceof Error ? error.message : 'Could not start the sprint.' }
      }
    },
    [folderPath],
  )

  return {
    trackerConnections,
    trackerPicker,
    setTrackerPicker,
    closeTrackerPicker,
    issueLinkIndex,
    startSprintFromTrackerIssue,
  }
}
