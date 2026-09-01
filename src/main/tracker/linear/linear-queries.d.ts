import type { NormalizedIssue } from '../../../shared/tracker/types';
export declare const LINEAR_PAGE_SIZE = 50;
export declare const LINEAR_ASSIGNED_MAX_PAGES = 20;
export declare const SEARCH_ISSUES_QUERY = "\n  query TrackerLinearSearch($term: String!, $first: Int!, $after: String) {\n    issueSearch(term: $term, first: $first, after: $after) {\n      pageInfo { hasNextPage endCursor }\n      nodes { \n  id\n  identifier\n  title\n  description\n  url\n  priority\n  priorityLabel\n  updatedAt\n  state { name type }\n  assignee { id displayName }\n  labels(first: 50) { nodes { name } }\n }\n    }\n  }\n";
export declare const LIST_ISSUES_QUERY = "\n  query TrackerLinearList($first: Int!, $after: String) {\n    issues(first: $first, after: $after, orderBy: updatedAt) {\n      pageInfo { hasNextPage endCursor }\n      nodes { \n  id\n  identifier\n  title\n  description\n  url\n  priority\n  priorityLabel\n  updatedAt\n  state { name type }\n  assignee { id displayName }\n  labels(first: 50) { nodes { name } }\n }\n    }\n  }\n";
export declare const ASSIGNED_ISSUES_QUERY = "\n  query TrackerLinearAssigned($first: Int!, $after: String) {\n    viewer {\n      assignedIssues(\n        first: $first\n        after: $after\n        filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }\n      ) {\n        pageInfo { hasNextPage endCursor }\n        nodes { \n  id\n  identifier\n  title\n  description\n  url\n  priority\n  priorityLabel\n  updatedAt\n  state { name type }\n  assignee { id displayName }\n  labels(first: 50) { nodes { name } }\n }\n      }\n    }\n  }\n";
export declare const FETCH_ISSUE_QUERY = "\n  query TrackerLinearIssue($id: String!) {\n    issue(id: $id) {\n      \n  id\n  identifier\n  title\n  description\n  url\n  priority\n  priorityLabel\n  updatedAt\n  state { name type }\n  assignee { id displayName }\n  labels(first: 50) { nodes { name } }\n\n      comments(first: 100) { \n  nodes {\n    body\n    createdAt\n    user { displayName }\n  }\n }\n    }\n  }\n";
export declare const VIEWER_PROBE_QUERY = "\n  query TrackerLinearProbe {\n    viewer { id displayName }\n    organization { name }\n  }\n";
export type LinearIssueNode = {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    priority: number | null;
    priorityLabel: string | null;
    updatedAt: string | null;
    state: {
        name: string;
        type: string;
    } | null;
    assignee: {
        id: string | null;
        displayName: string | null;
    } | null;
    labels: {
        nodes: Array<{
            name: string;
        }>;
    } | null;
    comments?: {
        nodes: Array<LinearCommentNode>;
    } | null;
};
export type LinearCommentNode = {
    body: string;
    createdAt: string | null;
    user: {
        displayName: string | null;
    } | null;
};
export type LinearPageInfo = {
    hasNextPage: boolean;
    endCursor: string | null;
};
export type LinearIssueConnection = {
    pageInfo: LinearPageInfo;
    nodes: LinearIssueNode[];
};
export type SearchIssuesData = {
    issueSearch: LinearIssueConnection;
};
export type ListIssuesData = {
    issues: LinearIssueConnection;
};
export type AssignedIssuesData = {
    viewer: {
        assignedIssues: LinearIssueConnection;
    } | null;
};
export type FetchIssueData = {
    issue: LinearIssueNode | null;
};
export type ViewerProbeData = {
    viewer: {
        id: string;
        displayName: string | null;
    } | null;
    organization: {
        name: string | null;
    } | null;
};
export declare function normalizeLinearIssue(node: LinearIssueNode, connectionId: string): NormalizedIssue;
