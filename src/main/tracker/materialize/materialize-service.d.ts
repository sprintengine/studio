import { type TrackerConnection, type TrackerFetchIssueInput, type TrackerFetchIssueResult, type TrackerMaterializeInput, type TrackerMaterializeResult } from '../../../shared/tracker/types';
export type MaterializeTrackerAccess = {
    getConnection(id: string): Promise<TrackerConnection | undefined>;
    fetchIssue(input: TrackerFetchIssueInput): Promise<TrackerFetchIssueResult>;
};
export declare function materializeTrackerIssues(input: TrackerMaterializeInput & {
    tracker: MaterializeTrackerAccess;
}): Promise<TrackerMaterializeResult>;
