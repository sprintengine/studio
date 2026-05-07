import type { MobileControlCommand, MobileSwarmCommandResult } from '../sprintengine/command'
import { MobileSwarmSnapshotService } from '../sprintengine/snapshot'
import { acceptedBridgeCommand } from './command-results'

export async function dispatchSnapshotRequest(input: {
  command: MobileControlCommand
  snapshotService: MobileSwarmSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
}): Promise<MobileSwarmCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider } = input
  const statePaths = await statePathsProvider()
  const snapshot = await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths,
  })
  return acceptedBridgeCommand(command, snapshot)
}
