export type SafeExternalUrl = {
    ok: true;
    url: string;
} | {
    ok: false;
    message: string;
};
export declare function safeExternalUrl(url: unknown): SafeExternalUrl;
