import { isAbsolute, resolve } from 'path';
import { MobileSprintEngineCommandError } from './command-error';
import { isPathInsideOrEqual } from './path-utils';
export function resolveSprintEngineArtifactFilePath(state, artifactPathInput) {
    const artifactPath = artifactPathInput.trim();
    if (!artifactPath) {
        throw new MobileSprintEngineCommandError('path_not_allowed', 'Artifact path is required.', false);
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(artifactPath)) {
        throw new MobileSprintEngineCommandError('path_not_allowed', 'Artifact path must be a workspace file path.', false);
    }
    const fullPath = isAbsolute(artifactPath)
        ? resolve(artifactPath)
        : [
            resolve(state.workspaceRoot, artifactPath),
            resolve(state.teamDirectory, artifactPath),
        ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
            ?? resolve(state.workspaceRoot, artifactPath);
    if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
        throw new MobileSprintEngineCommandError('path_not_allowed', 'Artifact path must stay inside the sprint team directory.', false);
    }
    return fullPath;
}
