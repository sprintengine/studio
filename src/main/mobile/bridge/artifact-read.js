import { readFile } from 'fs/promises';
import { basename, dirname } from 'path';
import { resolveArtifactPathForRead } from './artifact-path';
import { acceptedBridgeCommand, failedCommandResult } from './command-results';
import { stringPayload } from './command-payload';
export async function dispatchArtifactRead(input) {
    const { command, snapshotService, desktopSessionId, statePathsProvider } = input;
    const sprintEngineId = stringPayload(command.payload, 'sprintEngineId');
    const artifactId = stringPayload(command.payload, 'artifactId');
    const previewMode = stringPayload(command.payload, 'previewMode');
    if (previewMode !== 'text' && previewMode !== 'markdown') {
        return failedCommandResult(command, 'path_not_allowed', 'Only text and markdown artifact preview modes are supported.');
    }
    const statePaths = await statePathsProvider();
    const snapshot = await snapshotService.readSnapshot({
        desktopSessionId,
        statePaths,
    });
    const sprintengine = snapshot.sprintEngines.find((candidate) => candidate.sprintEngineId === sprintEngineId);
    const artifact = sprintengine?.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!sprintengine || !artifact?.path) {
        return failedCommandResult(command, 'artifact_not_found', 'Requested artifact was not found.');
    }
    const artifactPath = resolveArtifactPathForRead(dirname(sprintengine.statePath), sprintengine.workspacePath, artifact.path);
    const content = await readFile(artifactPath, 'utf8');
    return acceptedBridgeCommand(command, {
        artifactId,
        sprintEngineId,
        previewMode,
        path: artifact.path,
        name: basename(artifactPath),
        content,
    });
}
