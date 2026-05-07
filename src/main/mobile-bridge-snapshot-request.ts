import type { MobileControlCommand, MobileSwarmCommandResult } from './mobile/sprintengine/command'
import { MobileSwarmSnapshotService } from './mobile/sprintengine/snapshot'
import { acceptedBridgeCommand } from './mobile-bridge-command-results'

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
