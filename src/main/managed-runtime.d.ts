export type PythonSource = 'override' | 'bundled' | 'venv' | 'system';
export type ResolvedPython = {
    /** Absolute path or bare command (e.g. `python3`) to spawn. */
    command: string;
    /** Where the interpreter came from, for diagnostics and telemetry. */
    source: PythonSource;
};
export type RuntimeEnv = {
    platform: NodeJS.Platform;
    /** electron `process.resourcesPath` (where extraResources land when packaged). */
    resourcesPath: string | undefined;
    /** electron `app.isPackaged`. */
    isPackaged: boolean;
    /** electron `process.execPath` — the Electron binary, usable as Node. */
    execPath: string;
    /** Working directory / dev checkout root used to find `resources/` in dev. */
    cwd: string;
    /** Explicit interpreter override (MULTICODE_PYTHON), if set. */
    pythonOverride?: string | undefined;
    /** Predicate for path existence (injectable for tests). */
    exists: (path: string) => boolean;
};
export declare const RUNTIME_RESOURCE_DIR = "runtime";
/** Absolute path to the bundled CPython interpreter, or null if not vendored. */
export declare function bundledPythonPath(env: RuntimeEnv): string | null;
/** Absolute path to the bundled npm CLI entrypoint, or null if not vendored. */
export declare function bundledNpmCliPath(env: RuntimeEnv): string | null;
/**
 * Resolves the Python interpreter to spawn, in precedence order:
 *   1. MULTICODE_PYTHON override (operator escape hatch / CI).
 *   2. Bundled CPython under resources/runtime (the shipping default).
 *   3. A repo `.venv` at `repoRoot` (dev convenience for contributors).
 *   4. System `python3` (POSIX) / `python` (Windows) on PATH (last resort).
 */
export declare function resolveManagedPython(env: RuntimeEnv, repoRoot?: string): ResolvedPython;
/** Minimal logger surface so this is unit-testable without console side effects. */
export type RuntimeLogger = {
    log: (msg: string) => void;
    warn: (msg: string) => void;
};
/**
 * Emits a one-line diagnostic about which Python interpreter the app resolved,
 * and warns loudly when a *packaged* build did not land on the bundled CPython.
 *
 * In a packaged build `source` should always be `bundled` (or an explicit
 * `override`). A `venv`/`system` result there means `runtimes:fetch` never ran
 * or the payload is missing from the build, so the app is silently leaning on a
 * user's system `python3` — possibly the wrong version, possibly absent. That
 * degrades Sprint Engine / Switchboard / souls at runtime instead of
 * failing the build, so we surface it in the logs rather than let it pass quietly.
 */
export declare function reportManagedPythonResolution(resolved: ResolvedPython, env: RuntimeEnv, logger?: RuntimeLogger): void;
/**
 * The Node binary to use for our own JS tooling and npm installs. Electron's
 * own executable runs as Node when ELECTRON_RUN_AS_NODE=1 is set (see
 * `managedNodeEnv`), so we never bundle a second Node.
 */
export declare function managedNodeBinary(env: RuntimeEnv): string;
/**
 * Environment that turns the Electron binary into a plain Node interpreter.
 * Always returns a fresh object so callers can spread it without mutating the
 * source env.
 */
export declare function managedNodeEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * Prepends a shim directory onto PATH so spawned shells (CLI installers) resolve
 * `node`/`npm` to our managed runtime. Idempotent: a shim dir already present is
 * left in place.
 */
export declare function withManagedRuntimePath(env: Record<string, string>, shimDir: string, platform: NodeJS.Platform): Record<string, string>;
/** Builds a RuntimeEnv from the live process, lazily consulting Electron. */
export declare function currentRuntimeEnv(overrides?: Partial<RuntimeEnv>): RuntimeEnv;
/** Convenience: resolve managed Python against the live process. */
export declare function getManagedPython(repoRoot?: string): ResolvedPython;
/**
 * Sanitizes a spawn environment for the bundled CPython. python-build-standalone
 * is relocatable and locates its stdlib relative to the executable, but a stray
 * `PYTHONHOME` (set by pyenv/conda/homebrew users) overrides that and points the
 * interpreter at a foreign stdlib — a hard startup failure. We strip it (and
 * `PYTHONSTARTUP`) only for the bundled interpreter; for venv/system Python the
 * user's environment is left untouched.
 */
export declare function managedPythonSpawnEnv<T extends NodeJS.ProcessEnv>(base: T, source: PythonSource): T;
/** User-writable directory that npm global installs are redirected into. */
export declare function getManagedNpmPrefixDir(platform?: NodeJS.Platform): string;
/** Directory holding the managed `node`/`npm` shims. */
export declare function getManagedRuntimeShimDir(platform?: NodeJS.Platform): string;
/**
 * Writes `node`/`npm` shims that run the Electron binary as Node, plus a `bin`
 * directory under the writable npm prefix. Returns the shim dir, or null when
 * npm is not vendored (e.g. dev builds before `runtimes:fetch`).
 */
export declare function ensureManagedRuntimeShims(env?: RuntimeEnv): {
    shimDir: string;
    prefixBinDir: string;
} | null;
