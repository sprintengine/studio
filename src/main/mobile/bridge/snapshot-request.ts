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

  for (let includedCount = snapshot.sprintEngines.length - 1; includedCount >= 0; includedCount -= 1) {
    const candidate = limitSprintEngines(snapshot, includedCount)
    if (snapshotFitsRelayResult(command, candidate)) {
      return candidate
    }
  }

  return snapshot
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
