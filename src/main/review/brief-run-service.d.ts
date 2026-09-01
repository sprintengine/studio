import { type ReviewBrief } from '../../shared/review';
import type { GuideRunPhase } from './guide-run-registry';
export { BRIEF_RUN_EVENT_TOPIC } from '../../shared/review';
export type BriefRunPhase = GuideRunPhase;
export interface BriefRunEvent {
    workspaceId: string;
    phase: BriefRunPhase;
    detail?: string;
}
export declare function readBriefFromDir(targetDir: string): Promise<ReviewBrief | null>;
export declare function writeBriefAtomic(targetDir: string, brief: ReviewBrief): Promise<void>;
