import { pathExists } from './filesystem-workspace';
import { assertNotDirectSprintEngineStateMutation } from './sprintengine-state-guard';
export declare function createFilesystemMutationHandlers(): {
    assertNotDirectSprintEngineStateMutation: typeof assertNotDirectSprintEngineStateMutation;
    getUniqueCopyPath: (destinationDir: string, sourceName: string, sourcePath: string) => Promise<string>;
    pathExists: typeof pathExists;
    trashItem(targetPath: string): Promise<void>;
};
