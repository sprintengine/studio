import type { McpSettings, ReviewBriefRunDepth, TerminalSessionSnapshot, TerminalSpawnResult } from '../../shared/electron-api';
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc';
import type { BriefRunEvent } from './brief-run-service';
import { type GuideRunRegistry, type GuideRunStatus } from './guide-run-registry';
export declare const REVIEW_GUIDE_SKILL_ID = "review-guide";
export declare const REVIEW_GUIDE_AGENT_NAME = "Review guide";
export declare function reviewGuideAgentId(reviewId: string): string;
export interface GuideTerminalHandle {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    cli: string;
}
export type GuideRunStartResult = {
    ok: true;
    guide: GuideTerminalHandle;
    reused: boolean;
} | {
    ok: true;
    joined: true;
    status: GuideRunStatus;
    guide: GuideTerminalHandle;
} | {
    ok: false;
    error: string;
};
export type GuideAskResult = {
    ok: true;
    guide: GuideTerminalHandle;
} | {
    ok: false;
    error: string;
};
export interface GuideRunStartInput {
    reviewId: string;
    projectRoot: string;
    hostWorkspaceId?: string;
    depth: ReviewBriefRunDepth;
    affectedStepIds?: string[];
    cli?: string;
    cliModel?: string;
    restart?: boolean;
}
export interface GuideAskInput {
    reviewId: string;
    projectRoot: string;
    hostWorkspaceId?: string;
    question: string;
    cli?: string;
    cliModel?: string;
}
export interface GuideAgentExit {
    agentId?: string;
    executionId: string;
    exitCode: number;
}
export interface GuideTerminalDeps {
    listWorkspaces: () => ReadonlyArray<{
        id: string;
        folderPath?: string | null;
        mode?: string;
    }>;
    terminal: {
        list: () => TerminalSessionSnapshot[];
        spawn: (payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult>;
        sendPrompt: (sessionId: string, text: string) => Promise<{
            ok: boolean;
            message?: string;
        }>;
        kill: (sessionId: string) => void;
        setReapExempt: (sessionId: string, exempt: boolean) => void;
        onAgentSessionExit: (listener: (event: GuideAgentExit) => void) => () => void;
    };
    resolveSkillInvocation: (cli: string) => string | undefined;
    launchSettings?: () => {
        cliRuntimes?: Record<string, {
            command: string;
            useWsl: boolean;
        }>;
        mcp?: McpSettings;
    };
    emit: (event: BriefRunEvent) => void;
    guideRuns?: GuideRunRegistry;
}
export declare class ReviewGuideTerminalService {
    private readonly deps;
    private readonly guideRuns;
    private readonly inFlight;
    private nextExecution;
    private readonly stopWatchdog;
    constructor(deps: GuideTerminalDeps);
    dispose(): void;
    startRun(input: GuideRunStartInput): Promise<GuideRunStartResult>;
    ask(input: GuideAskInput): Promise<GuideAskResult>;
    stop(reviewId: string): void;
    clearReapExempt(reviewId: string): void;
    private onAgentExit;
    private prepareTerminal;
    private findGuideSession;
    private deliver;
    private buildRunPrompt;
    private buildAskPrompt;
    private skillLead;
    private resolveHostWorkspace;
    private lastAgentCli;
    private currentHandle;
    private emitPhase;
    private fail;
}
export declare function createReviewGuideTerminalService(deps: GuideTerminalDeps): ReviewGuideTerminalService;
export declare function recordGuideRunEvent(event: BriefRunEvent, registry?: GuideRunRegistry): void;
