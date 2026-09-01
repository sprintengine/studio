import { type TrackerConnection } from '../../../shared/tracker/types';
export declare const JIRA_API_BASE = "/rest/api/2";
export type JiraRequest = {
    connection: TrackerConnection;
    secret: string;
    path: string;
    query?: Record<string, string | number | undefined>;
    method?: 'GET' | 'POST';
    body?: unknown;
};
export declare function jiraFetch(request: JiraRequest, fetchImpl: typeof fetch): Promise<unknown>;
