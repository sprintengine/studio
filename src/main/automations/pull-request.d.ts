export type AutomationPullRequestResult = {
    ok: true;
    url: string;
    created: boolean;
} | {
    ok: false;
    reason: string;
};
export type CommandResult = {
    ok: boolean;
    stdout: string;
    stderr: string;
};
export type PullRequestDeps = {
    runGit: (cwd: string, args: string[]) => Promise<CommandResult>;
    runGh: (cwd: string, args: string[]) => Promise<CommandResult>;
};
export type OpenAutomationRunPullRequestInput = {
    worktreePath: string;
    branch: string;
    title: string;
    body: string;
    /** Backstop commit message used when the agent left uncommitted work. */
    commitMessage?: string;
};
export declare function openAutomationRunPullRequest(input: OpenAutomationRunPullRequestInput, deps?: PullRequestDeps): Promise<AutomationPullRequestResult>;
export declare const defaultPullRequestDeps: PullRequestDeps;
