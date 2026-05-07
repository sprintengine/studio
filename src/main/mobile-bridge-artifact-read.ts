import { readFile } from 'fs/promises'
import { basename, dirname } from 'path'
import type { MobileControlCommand, MobileSwarmCommandResult } from './mobile/sprintengine/command'
import { MobileSwarmSnapshotService } from './mobile/sprintengine/snapshot'
import { resolveArtifactPathForRead } from './mobile-bridge-artifact-path'
import { acceptedBridgeCommand, failedCommandResult } from './mobile-bridge-command-results'
import { stringPayload } from './mobile-bridge-command-payload'

export async function dispatchArtifactRead(input: {
  command: MobileControlCommand
  snapshotService: MobileSwarmSnapshotService
  desktopSessionId: string
  statePathsProvider: () => Promise<string[]>
}): Promise<MobileSwarmCommandResult> {
  const { command, snapshotService, desktopSessionId, statePathsProvider } = input
  const swarmId = stringPayload(command.payload, 'swarmId')
  const artifactId = stringPayload(command.payload, 'artifactId')
  const previewMode = stringPayload(command.payload, 'previewMode')
  if (previewMode !== 'text' && previewMode !== 'markdown') {
    return failedCommandResult(command, 'path_not_allowed', 'Only text and markdown artifact preview modes are supported.')
  }

  const statePaths = await statePathsProvider()
  const snapshot = await snapshotService.readSnapshot({
    desktopSessionId,
    statePaths,
  })
  const sprintengine = snapshot.swarms.find((candidate) => candidate.swarmId === swarmId)
  const artifact = sprintengine?.artifacts.find((candidate) => candidate.artifactId === artifactId)
  if (!sprintengine || !artifact?.path) {
    return failedCommandResult(command, 'artifact_not_found', 'Requested artifact was not found.')
  }

  const artifactPath = resolveArtifactPathForRead(dirname(sprintengine.statePath), sprintengine.workspacePath, artifact.path)
  const content = await readFile(artifactPath, 'utf8')
  return acceptedBridgeCommand(command, {
    artifactId,
    swarmId,
    previewMode,
    path: artifact.path,
    name: basename(artifactPath),
    content,
  })
}
