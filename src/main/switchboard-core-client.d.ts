export type SwitchboardCoreCommandResult = {
    ok: true;
    payload: Record<string, unknown>;
} | {
    ok: false;
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
};
export declare function workspaceArgs(workspaceRoot: string): string[];
export declare function runSwitchboardCore(args: string[]): Promise<SwitchboardCoreCommandResult>;
