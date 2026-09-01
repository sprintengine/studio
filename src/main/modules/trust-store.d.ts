export declare function trustedModulesPath(userDataDir: string): string;
export declare function parseTrustedModules(raw: string): Map<string, string>;
export declare function readTrustedModulesSync(userDataDir: string): Map<string, string>;
export type TrustWriteResult = {
    ok: boolean;
    message?: string;
};
export declare function setModuleTrust(userDataDir: string, id: string, fingerprint: string | null): Promise<{
    result: TrustWriteResult;
    trustedModules: Map<string, string>;
    previous: string | null;
}>;
