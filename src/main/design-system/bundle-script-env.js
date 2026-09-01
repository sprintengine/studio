// Forked bundle generator scripts must not inherit the full main-process
// environment: anything in the Electron main env (tokens, proxy credentials,
// signing secrets) would be readable by every script the runner executes.
// Bundle scripts are stdlib-only by contract, so they get only what a node
// process needs to resolve binaries and its home/temp dirs. NODE_* is
// deliberately excluded — NODE_OPTIONS is an execution-injection vector.
export const BUNDLE_SCRIPT_ENV_ALLOWLIST = [
    'PATH',
    'HOME',
    'TMPDIR',
    // Windows equivalents, so the one allowlist works cross-platform.
    'USERPROFILE',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
];
/** Project the allowlisted variables out of a full process environment. */
export function bundleScriptEnv(source) {
    const env = {};
    for (const key of BUNDLE_SCRIPT_ENV_ALLOWLIST) {
        const value = source[key];
        if (value !== undefined)
            env[key] = value;
    }
    return env;
}
