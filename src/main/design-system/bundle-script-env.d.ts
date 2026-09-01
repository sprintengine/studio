export declare const BUNDLE_SCRIPT_ENV_ALLOWLIST: readonly ["PATH", "HOME", "TMPDIR", "USERPROFILE", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "PATHEXT"];
/** Project the allowlisted variables out of a full process environment. */
export declare function bundleScriptEnv(source: NodeJS.ProcessEnv): Record<string, string>;
