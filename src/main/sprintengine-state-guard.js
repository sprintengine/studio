import { lstat, readdir, realpath, stat } from 'fs/promises';
import { basename, dirname, resolve } from 'path';
import { isMissingPathError } from './filesystem-workspace';
function isSprintEngineStateFilePath(input) {
    const statePath = resolve(input);
    const teamDirectory = dirname(statePath);
    const sprintEngineDirectory = dirname(teamDirectory);
    const multiCodeDirectory = dirname(sprintEngineDirectory);
    const workspaceRoot = dirname(multiCodeDirectory);
    return (basename(statePath) === 'run.yaml'
        && basename(sprintEngineDirectory) === 'sprintengine'
        && basename(multiCodeDirectory) === '.multi-code'
        && workspaceRoot !== multiCodeDirectory);
}
async function getRealMutationTargetPath(targetPath) {
    try {
        await lstat(targetPath);
    }
    catch (error) {
        if (!isMissingPathError(error)) {
            throw error;
        }
        const parentDirectory = dirname(resolve(targetPath));
        try {
            return resolve(await realpath(parentDirectory), basename(targetPath));
        }
        catch (parentError) {
            if (isMissingPathError(parentError)) {
                return null;
            }
            throw parentError;
        }
    }
    try {
        return await realpath(targetPath);
    }
    catch (error) {
        if (isMissingPathError(error)) {
            return null;
        }
        throw error;
    }
}
async function getExistingDirectoryPath(targetPath) {
    try {
        const targetStats = await stat(targetPath);
        return targetStats.isDirectory() ? targetPath : null;
    }
    catch (error) {
        if (isMissingPathError(error)) {
            return null;
        }
        throw error;
    }
}
async function directorySubtreeContainsSprintEngineStatePath(directoryPath) {
    const visitedRealDirectories = new Set();
    const visit = async (currentDirectory) => {
        let realCurrentDirectory = null;
        try {
            realCurrentDirectory = await realpath(currentDirectory);
        }
        catch (error) {
            if (!isMissingPathError(error)) {
                throw error;
            }
        }
        if (realCurrentDirectory) {
            if (visitedRealDirectories.has(realCurrentDirectory)) {
                return false;
            }
            visitedRealDirectories.add(realCurrentDirectory);
        }
        let entries;
        try {
            entries = await readdir(currentDirectory, { withFileTypes: true });
        }
        catch (error) {
            if (isMissingPathError(error)) {
                return false;
            }
            throw error;
        }
        for (const entry of entries) {
            const entryPath = resolve(currentDirectory, entry.name);
            if (entry.name === 'run.yaml' && isSprintEngineStateFilePath(entryPath)) {
                return true;
            }
            if (entry.isDirectory() && await visit(entryPath)) {
                return true;
            }
        }
        return false;
    };
    return visit(directoryPath);
}
export async function assertNotDirectSprintEngineStateMutation(targetPath) {
    const realTargetPath = await getRealMutationTargetPath(targetPath);
    if (isSprintEngineStateFilePath(targetPath) || (realTargetPath && isSprintEngineStateFilePath(realTargetPath))) {
        throw new Error('Sprint run-store files must be updated through the Sprint Engine tool.');
    }
    const existingDirectoryPath = await getExistingDirectoryPath(targetPath);
    if (!existingDirectoryPath) {
        return;
    }
    if (await directorySubtreeContainsSprintEngineStatePath(existingDirectoryPath)) {
        throw new Error('Sprint run-store files must be updated through the Sprint Engine tool.');
    }
    const realDirectoryPath = realTargetPath && realTargetPath !== resolve(existingDirectoryPath)
        ? await getExistingDirectoryPath(realTargetPath)
        : null;
    if (realDirectoryPath && await directorySubtreeContainsSprintEngineStatePath(realDirectoryPath)) {
        throw new Error('Sprint run-store files must be updated through the Sprint Engine tool.');
    }
}
