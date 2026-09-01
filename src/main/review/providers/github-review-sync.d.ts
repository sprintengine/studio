import { type PullRequestProvider, type ReviewChangeSet, type ReviewComment } from '../../../shared/review';
import type { ReviewPostReviewResult } from '../../../shared/electron-api';
import { type GhRunner } from './github-pr-provider';
export interface WriteFetchResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
export type WriteFetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<WriteFetchResponseLike>;
export interface GithubReviewSyncDeps {
    gh: GhRunner;
    fetchImpl: WriteFetchLike;
    resolveToken: (host: string, provider: PullRequestProvider) => Promise<string | null>;
    now: () => string;
}
export type PostReviewResult = ReviewPostReviewResult;
export declare function postReview(changeset: ReviewChangeSet, comments: ReviewComment[], deps: GithubReviewSyncDeps): Promise<PostReviewResult>;
export declare function defaultReviewSyncDeps(): GithubReviewSyncDeps;
