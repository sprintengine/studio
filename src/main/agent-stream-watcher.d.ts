export type AgentStreamWatcherInput = {
    readinessPattern?: RegExp;
    completionSentinel?: string;
    rollingBufferSize?: number;
};
export type AgentStreamWatcherIngestResult = {
    readyMatched: boolean;
    completionMatched: boolean;
};
export type AgentStreamWatcher = {
    ingest(chunk: string): AgentStreamWatcherIngestResult;
    reset(): void;
};
export declare function createAgentStreamWatcher(input: AgentStreamWatcherInput): AgentStreamWatcher;
