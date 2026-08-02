import { useCallback, useEffect, useMemo, useState } from 'react'
import { basename } from '../../utils/paths'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { sprintEngineCoordinatorSeatForRoleCounts, sprintEngineRoleKey } from '../../utils/sprintengine'
import { backlogIssueLinkIndex } from './backlogTrackerPickerModel'
import { matchProxyItemByIssue } from '../../utils/sprintengineTrackerSeeding'
import { startTrackerProxySprint } from '../../utils/sprintengineWorkspaceCreation'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  resolveInitialSprintEngineRoster,
  sprintEngineLaunchRoleCounts,
} from '../workspace/newWorkspace/savedRosters'
import { SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS } from '../workspace/newWorkspace/controllers/sprintEngineController'
import { markdownTitle, workspaceRelativePath } from '../workspace/newWorkspace/helpers'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../utils/sprintengineAutomationLifecycle'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import type { NormalizedIssue, RedactedTrackerConnection } from '../../../../shared/electron-api'
import type { BacklogItem, BacklogScanResult } from '../../utils/backlog'

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
  runScan: () => Promise<BacklogScanResult | null>
}): BacklogTrackerSeeding {
  const { items, folderPath, runScan } = params

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
        // 1. Materialize the single issue — writes the proxy item fresh from the
        // tracker. The issue carries its own owning connection id.
        const materialized = await window.api.trackerMaterialize({
          workspaceRoot: folderPath,
          connectionId: issue.connectionId,
          externalIds: [issue.externalId],
        })
        if (!materialized.ok) return { ok: false, error: materialized.error.message }
        const failure = materialized.failed.find((entry) => entry.externalId === issue.externalId)
        if (failure) return { ok: false, error: failure.reason }
        // 2. Re-scan and locate the freshly written proxy item by its issue link.
        const scanResult = await runScan()
        const item = scanResult
          ? matchProxyItemByIssue(scanResult.items, issue.provider, issue.externalId)
          : null
        if (!item) {
          return { ok: false, error: 'Added to the backlog, but the new item could not be located to start a sprint.' }
        }
        // 3. Resolve the user's saved roster (never invents a roster) + auto-run mode.
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
        const baseTeamName = slugifySprintEngineName(basename(item.relativePath).replace(/\.(md|html?)$/i, ''))
        // 4. Create the plan-sourced run from the just-refreshed on-disk item + link it.
        const result = await startTrackerProxySprint({
          rootPath: folderPath,
          baseTeamName,
          goal: markdownTitle(item.sourceContent) ?? (issue.title.trim() || issue.nativeKey),
          sourceRelativePath: item.relativePath,
          sourceContent: item.sourceContent,
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
            cliPermissionPreset: 'default',
            maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
          },
          // Null → addWorkspace places the run in the current window (falls back to
          // the active workspace's window, then primary).
          workspaceWindowId: null,
          pathExists: window.api.pathExists,
          initializeSprintEngineState: window.api.initializeSprintEngineState,
          recordExecutionLink: async ({ workspaceRoot, sourceRelativePath, teamSlug, statePath }) => {
            const linked = await window.api.addOrUpdateBacklogLink({
              workspaceRoot,
              relativePath: sourceRelativePath,
              link: {
                id: `sprint-engine:${teamSlug}`,
                moduleId: 'sprint-engine',
                type: 'execution',
                label: 'Sprint',
                target: {
                  kind: 'sprintengine.run',
                  id: teamSlug,
                  path: workspaceRelativePath(workspaceRoot, statePath) ?? statePath,
                },
                status: 'active',
              },
              status: 'in_progress',
            })
            if (!linked.ok) throw new Error(linked.message)
          },
        })
        if (!result.ok) return { ok: false, error: result.message }
        // Re-scan so the new proxy row shows its running-sprint link immediately.
        await runScan()
        return { ok: true }
      } catch (error) {
        // Failure-isolated: a thrown IPC/creation error becomes a visible result,
        // never a stuck "starting" row or an unhandled rejection.
        return { ok: false, error: error instanceof Error ? error.message : 'Could not start the sprint.' }
      }
    },
    [folderPath, runScan],
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
