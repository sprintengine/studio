import type { ReviewChangeSetReadResult, ReviewSourceInput, ReviewSourceProbe } from '../../shared/electron-api';
import { type ChangeSetFile, type ReviewChangeSet, type ReviewSource, type ReviewSourceKind } from '../../shared/review';
export declare const MAX_PATCH_BYTES: number;
export declare const MAX_CHANGESET_FILES = 400;
interface ReviewSourceBuild {
    source: ReviewSource;
    title: string;
    description?: string;
    baseRef: string;
    baseSha?: string;
    headRef?: string;
    headSha?: string;
    files: ChangeSetFile[];
    stats: {
        files: number;
        additions: number;
        deletions: number;
    };
    identity: string;
}
export interface ReviewSourceProvider {
    probe(input: ReviewSourceInput): Promise<ReviewSourceProbe>;
    build(input: ReviewSourceInput): Promise<ReviewSourceBuild>;
}
export declare function registerReviewSourceProvider(kind: ReviewSourceKind, provider: ReviewSourceProvider): void;
export declare class ReviewChangeSetService {
    detect(input: ReviewSourceInput): Promise<ReviewSourceProbe>;
    build(input: ReviewSourceInput): Promise<ReviewChangeSet>;
    ingest(input: ReviewSourceInput, targetDir: string): Promise<ReviewChangeSet>;
    read(targetDir: string): Promise<ReviewChangeSetReadResult>;
}
export declare function createReviewChangeSetService(): ReviewChangeSetService;
export declare function reviewChangeSetDir(workspaceRoot: string, workspaceId: string): string;
export {};
