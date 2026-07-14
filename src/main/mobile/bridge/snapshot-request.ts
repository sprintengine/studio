import { basename, dirname } from 'path'
import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'
import { MobileSprintEngineSnapshotService, sanitizeMobileSnapshotForRelay, type MobileControlSnapshot } from '../sprintengine/snapshot'
import {
  acceptedBridgeCommand,
  relayResultSummaryMaxBytes,
  relaySummaryByteLength,
  summarizeCommandResult,
} from './command-results'

const relaySnapshotResultTargetBytes = relayResultSummaryMaxBytes - 8 * 1024

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileSprintEngineSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
  workspaceRootsProvider?: () => Promise<string[]>
}): Promise<MobileSprintEngineCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider, workspaceRootsProvider } = input
  const allStatePaths = await statePathsProvider()
  const requestedSprintEngineId = command.type === 'snapshot.request' && typeof command.payload.sprintEngineId === 'string'
    ? command.payload.sprintEngineId
    : null
  const statePaths = requestedSprintEngineId
    ? allStatePaths.filter((statePath) => basename(dirname(statePath)) === requestedSprintEngineId)
    : allStatePaths
  // readSnapshot() returns the internal snapshot with real local paths; the
  // on-demand command-result path (workspace open / backlog refresh) does not go
  // through the publish emit() chokepoint, so sanitize here too or the relay
  // rejects the result for carrying local paths.
  const snapshot = sanitizeMobileSnapshotForRelay(await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths,
    workspaceRoots: workspaceRootsProvider ? await workspaceRootsProvider() : undefined,
  }))
  return acceptedBridgeCommand(command, relaySizedSnapshot(command, snapshot, requestedSprintEngineId !== null))
}

function relaySizedSnapshot(
  command: MobileControlCommand,
  snapshot: MobileControlSnapshot,
  scopedRequest: boolean,
): MobileControlSnapshot {
  if (snapshotFitsRelayResult(command, snapshot) || scopedRequest) {
    return snapshot
  }

  // Shed the role catalogs first (MC-1543). They are duplicated per backlog
  // workspace and are an enhancement — losing them costs the phone a
  // registry-accurate launch picker (it falls back to its bundled list), whereas
  // losing a sprint engine costs it a run it can no longer see or drive. Cheapest
  // thing in the payload, so it goes before anything load-bearing.
  const shed = withoutRoleCatalogs(snapshot)
  if (snapshotFitsRelayResult(command, shed)) {
    return shed
  }

  // Then the automations' recent-run history (item 47). The producer caps it (24
  // automations per project, 5 runs each, 160-char run text) but the caps bound a
  // PROJECT, not a snapshot: at full cap a single project measures ~27% of the
  // budget, so four workspace roots crowd the snapshot out on automations alone.
  // Run text is ~90% of those bytes, so dropping it is what buys the room back.
  // It goes above the sprint engines for the same reason the role catalogs do:
  // losing run history costs the phone some monitor detail on automations it can
  // still see, whereas losing a sprint engine costs it a run it can no longer see
  // or drive. `recentRuns` is optional on the wire, so shedding it is omitting it.
  const withoutRuns = withoutAutomationRecentRuns(shed)
  if (snapshotFitsRelayResult(command, withoutRuns)) {
    return withoutRuns
  }

  for (let includedCount = withoutRuns.sprintEngines.length - 1; includedCount >= 0; includedCount -= 1) {
    const candidate = limitSprintEngines(withoutRuns, includedCount)
    if (snapshotFitsRelayResult(command, candidate)) {
      return candidate
    }
  }

  return withoutRuns
}

function withoutRoleCatalogs(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  if (!snapshot.backlog?.some((workspace) => workspace.roles !== undefined)) {
    return snapshot
  }
  return {
    ...snapshot,
    backlog: snapshot.backlog.map(({ roles: _roles, ...workspace }) => workspace),
  }
}

function withoutAutomationRecentRuns(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  if (!snapshot.automations?.some((automation) => automation.recentRuns !== undefined)) {
    return snapshot
  }
  return {
    ...snapshot,
    automations: snapshot.automations.map(({ recentRuns: _recentRuns, ...automation }) => automation),
  }
}

function snapshotFitsRelayResult(command: MobileControlCommand, snapshot: MobileControlSnapshot): boolean {
  if (relaySummaryByteLength(snapshot) > relaySnapshotResultTargetBytes) {
    return false
  }
  const result = acceptedBridgeCommand(command, snapshot)
  return relaySummaryByteLength(summarizeCommandResult(result)) <= relaySnapshotResultTargetBytes
}

function limitSprintEngines(snapshot: MobileControlSnapshot, includedCount: number): MobileControlSnapshot {
  const sprintEngines = snapshot.sprintEngines.slice(0, includedCount)
  const includedIds = new Set(sprintEngines.map((sprintEngine) => sprintEngine.sprintEngineId))
  return {
    ...snapshot,
    sprintEngines,
    workspaces: snapshot.workspaces?.filter((workspace) =>
      workspace.kind !== 'sprintengine' || includedIds.has(workspace.workspaceId)
    ),
    snapshotLimits: {
      ...(snapshot.snapshotLimits ?? {}),
      sprintEngines: {
        included: sprintEngines.length,
        omitted: Math.max(0, snapshot.sprintEngines.length - sprintEngines.length),
        total: snapshot.sprintEngines.length,
        reason: 'relay_result_summary_size',
      },
    },
  }
}
