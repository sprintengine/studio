import type { BacklogItemLinkPayload } from '../../../shared/electron-api';
import type { NormalizedIssue, TrackerConnection, TrackerProviderId } from '../../../shared/tracker/types';
export declare function trackerProviderLabel(provider: TrackerProviderId): string;
export declare function proxyProvenanceMarker(provider: TrackerProviderId): string;
export declare const TRACKER_LINK_MODULE_ID = "tracker";
export declare const TRACKER_ISSUE_LINK_ID = "tracker:issue";
export declare function trackerIssueTargetKind(provider: TrackerProviderId): string;
export type ProxyExternalFields = {
    external_provider: string;
    external_connection: string;
    external_id: string;
    external_key: string;
    external_url: string;
};
export declare function proxyExternalFields(issue: NormalizedIssue, connection: TrackerConnection): ProxyExternalFields;
export declare function composeProxyBody(issue: NormalizedIssue): string;
export declare function proxyIssueLink(issue: NormalizedIssue): BacklogItemLinkPayload;
