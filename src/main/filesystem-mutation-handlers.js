import { shell } from 'electron';
import { getUniqueCopyPath } from './filesystem-copy';
import { pathExists } from './filesystem-workspace';
import { assertNotDirectSprintEngineStateMutation } from './sprintengine-state-guard';
export function createFilesystemMutationHandlers() {
    return {
        assertNotDirectSprintEngineStateMutation,
        getUniqueCopyPath: (destinationDir, sourceName, sourcePath) => getUniqueCopyPath(destinationDir, sourceName, sourcePath, pathExists),
        pathExists,
        async trashItem(targetPath) {
            await shell.trashItem(targetPath);
        },
    };
}
