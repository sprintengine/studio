import type { GitRepoOperation, GitStatusSnapshot } from './git';
/** Which merge/rebase/cherry-pick/revert operation is parked in the repo, if any. */
export declare function getGitOperationInProgress(repoRoot: string): Promise<GitRepoOperation | null>;
export declare function getGitStatus(repoRoot: string): Promise<GitStatusSnapshot>;
