import type { GitHubCloneInput, GitHubCloneResult } from '../shared/electron-api';
/**
 * Clone a repository into parentDir/folderName for the new-workspace flow.
 * Never throws — failures return `{ok:false}` with a user-facing message so
 * the hub can surface them in the folder field's error slot.
 */
export declare function cloneGitHubRepo(input: GitHubCloneInput & {
    token?: string | null;
}): Promise<GitHubCloneResult>;
