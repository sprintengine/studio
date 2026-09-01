import type { BacklogItemStatusPayload } from '../shared/electron-api';
export type SprintEngineLinkWriteResult = {
    ok: true;
} | {
    ok: false;
    message: string;
};
/**
 * Record the run -> item execution link on the originating Backlog item and move
 * it to `in_progress`, mirroring the desktop creation flow.
 *
 * This link is load-bearing, not bookkeeping: it is the ONLY backlog->run
 * correspondence that exists, and `attachSprintEnginePullRequestLink` finds the
 * originating item by scanning for it. No execution link, no PR link, ever.
 *
 * `childRelativePaths` are the launched epic's children. They get the same run
 * link, recorded `pending` and remembering the status they held (MC-2017): a
 * child moves to `in_progress` when its own task claims, lands only when the
 * sprint does, and goes back to `priorStatus` if the sprint is abandoned. This
 * writer must stay identical to the desktop one — a phone-started epic and a
 * desktop-started one are the same run, and the projection tick that drives these
 * links cannot tell (or care) which wrote them.
 */
export declare function recordSprintEngineExecutionLink(input: {
    workspaceRoot: string;
    relativePath: string;
    statePath: string;
    childRelativePaths?: readonly {
        relativePath: string;
        status: BacklogItemStatusPayload;
    }[];
}): Promise<SprintEngineLinkWriteResult>;
/** One project's pull request, as the item should link it. */
export type SprintEnginePullRequestLinkInput = {
    /** Declared repo id; `primary` (or omitted) keeps the original bare link id. */
    repoId?: string;
    url: string;
    /** Project name shown in the link label; omitted for a single-project run. */
    repoLabel?: string;
};
/**
 * Attach a run's pull requests to the Backlog item that started it — one link per
 * project the run delivered (MC-1612).
 *
 * There is no reverse index from a run to its item, so the item is found the way
 * the renderer's projection tick finds it: scan the object store for a record
 * whose execution link resolves to this run's run.yaml. A no-op when nothing
 * links to the run (a run started outside the Backlog has no item to carry a PR)
 * and when the same URL is already attached for that project, so repeat calls do
 * not churn the store.
 *
 * The PR links are `external` and therefore lifecycle-neutral: attaching them
 * never moves the item's status. Completion is the run's business, not the PR's.
 *
 * Every item linking this run gets them, not just the first. Normally that is
 * exactly one item, but if two genuinely share a run they should both show its
 * pull requests — silently stopping at the first would be the surprising choice.
 */
export declare function attachSprintEnginePullRequestLink(input: {
    workspaceRoot: string;
    statePath: string;
    pullRequests: readonly SprintEnginePullRequestLinkInput[];
    now?: () => Date;
}): Promise<SprintEngineLinkWriteResult>;
