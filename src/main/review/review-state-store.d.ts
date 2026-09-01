import type { ReviewStateReadResult } from '../../shared/electron-api';
import { type ReviewWorkspaceState } from '../../shared/review';
export declare function readReviewState(reviewDir: string): Promise<ReviewStateReadResult>;
export declare function writeReviewState(reviewDir: string, state: ReviewWorkspaceState): Promise<void>;
