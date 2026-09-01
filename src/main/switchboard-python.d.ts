export type SwitchboardPythonCommandResult = {
    ok: true;
    payload: Record<string, unknown>;
} | {
    ok: false;
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
};
export declare function runSwitchboardPythonJsonCommand(args: string[]): Promise<SwitchboardPythonCommandResult>;
export declare function shutdownSwitchboardPythonCommands(): Promise<void>;
