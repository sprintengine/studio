export type GitHubTokenStatus = {
    configured: boolean;
    source: 'settings' | 'environment' | 'none';
    encryptionAvailable: boolean;
};
export declare class GitHubTokenStore {
    private inMemoryToken;
    private get tokenPath();
    getStatus(): Promise<GitHubTokenStatus>;
    resolveToken(explicitToken?: string | null): Promise<string>;
    readToken(): Promise<string | null>;
    writeToken(token: string): Promise<GitHubTokenStatus>;
    clearToken(): Promise<GitHubTokenStatus>;
}
