export declare function resolveTailscaleBinary(): string;
/** Run a Tailscale subcommand, or null when it is unavailable or fails. */
export declare function runTailscale(args: readonly string[], timeoutMs: number, maxBuffer?: number): Promise<string | null>;
