export type CliInstallResult = {
    ok: boolean;
    binDir: string;
    installed: string[];
    errors: string[];
};
export declare function getMulticodeCliBinDir(): string;
export declare function withMulticodeCliPath(env: Record<string, string>): Record<string, string>;
export declare function installMulticodeCliTools(): CliInstallResult;
