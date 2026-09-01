import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ReviewChangeSetService } from './changeset-service';
import type { ReviewGuideTerminalService } from './guide-terminal-service';
import { type GuideRunRegistry } from './guide-run-registry';
import { type GithubReviewSyncDeps } from './providers/github-review-sync';
export interface ReviewIpcDeps {
    changeSetService: ReviewChangeSetService;
    guideTerminals: Pick<ReviewGuideTerminalService, 'startRun' | 'ask' | 'stop'>;
    isUserWindowSender?: (event: IpcMainInvokeEvent) => boolean;
    reviewSyncDeps?: GithubReviewSyncDeps;
    guideRuns?: Pick<GuideRunRegistry, 'status'>;
}
export declare function registerReviewIpc(ipcMain: IpcMain, { changeSetService, guideTerminals, isUserWindowSender, reviewSyncDeps, guideRuns }: ReviewIpcDeps): void;
