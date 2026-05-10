import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'
import { MobileSprintEngineSnapshotService } from '../sprintengine/snapshot'
import { acceptedBridgeCommand } from './command-results'

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileSprintEngineSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
}): Promise<MobileSprintEngineCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider } = input
  const statePaths = await statePathsProvider()
  const snapshot = await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths,
  })
  return acceptedBridgeCommand(command, snapshot)
}
