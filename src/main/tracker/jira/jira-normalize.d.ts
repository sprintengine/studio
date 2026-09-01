import type { NormalizedIssue, TrackerConnection } from '../../../shared/tracker/types';
type JiraAssignee = {
    accountId?: unknown;
    name?: unknown;
    key?: unknown;
    displayName?: unknown;
} | null;
export type JiraIssueRecord = {
    id?: unknown;
    key?: unknown;
    fields?: {
        summary?: unknown;
        description?: unknown;
        status?: {
            name?: unknown;
            statusCategory?: {
                key?: unknown;
            };
        };
        priority?: {
            name?: unknown;
        } | null;
        labels?: unknown;
        assignee?: JiraAssignee;
        updated?: unknown;
        comment?: {
            comments?: unknown;
        } | null;
    };
};
export declare function normalizeJiraIssue(record: JiraIssueRecord, connection: TrackerConnection): NormalizedIssue;
export {};
