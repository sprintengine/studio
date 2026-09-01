type MainDiagnosticsOptions = {
    enabled: boolean;
};
export declare function createMainDiagnostics({ enabled }: MainDiagnosticsOptions): {
    logMainPerfEvent: (scope: string, event: string, payload: Record<string, unknown>) => void;
    withIpcDiagnostics: <T>(scope: string, event: string, payload: Record<string, unknown>, action: () => Promise<T>) => Promise<T>;
};
export {};
