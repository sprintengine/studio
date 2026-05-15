import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot'
import { acceptedBridgeCommand } from './command-results'

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileSprintEngineSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
  workspaceRootsProvider?: () => Promise<string[]>
}): Promise<MobileSprintEngineCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider, workspaceRootsProvider } = input
  const statePaths = await statePathsProvider()
  const snapshot = await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths,
    workspaceRoots: workspaceRootsProvider ? await workspaceRootsProvider() : undefined,
  })
  return acceptedBridgeCommand(command, snapshot)
}
