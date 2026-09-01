import { spawn } from 'child_process';
import { getPluginManifest } from './plugin-registry-instance';
import { withMulticodeCliPath } from './cli-install';
import { currentRuntimeEnv, ensureManagedRuntimeShims, withManagedRuntimePath, } from './managed-runtime';
// Exit code our probe scripts use to signal "binary not found on PATH" so we
// can distinguish a missing CLI from a CLI that exists but whose --version
// failed for some other reason.
const NOT_FOUND_EXIT = 3;
const PATH_SENTINEL = 'MULTICODE_PATH:';
// Maps the OS platform + per-CLI WSL override onto the manifest install bucket.
// WSL is a logical target (Windows host, POSIX guest) distinct from win32.
export function resolveInstallPlatform(platform, useWsl) {
    if (platform === 'win32')
        return useWsl ? 'wsl' : 'win32';
    if (platform === 'darwin')
        return 'darwin';
    // Treat any other POSIX-like platform (linux, and uncommon ones) as linux.
    return 'linux';
}
function isPosixTarget(target) {
    return target === 'darwin' || target === 'linux' || target === 'wsl';
}
function posixSingleQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function powerShellSingleQuote(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
// Wraps a shell snippet in the right host shell for the target. POSIX targets
// run through a login shell so user-local install dirs (~/.local/bin, npm
// global prefix) are on PATH; WSL routes through wsl.exe.
function shellDescriptorForScript(target, script) {
    if (target === 'win32') {
        return {
            file: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        };
    }
    if (target === 'wsl') {
        return { file: 'wsl.exe', args: ['-e', 'bash', '-lc', script] };
    }
    return { file: 'bash', args: ['-lc', script] };
}
// Builds a script that prints the resolved path and version, or exits
// NOT_FOUND_EXIT when the binary is not on PATH.
export function buildProbeDescriptor(input) {
    const { binary, versionArgs, target } = input;
    if (isPosixTarget(target)) {
        const bin = posixSingleQuote(binary);
        const versionPart = versionArgs.map(posixSingleQuote).join(' ');
        const script = [
            `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`,
            `printf '${PATH_SENTINEL}%s\\n' "$(command -v ${bin})"`,
            `${bin} ${versionPart} 2>&1 || true`,
        ].join('\n');
        return shellDescriptorForScript(target, script);
    }
    const bin = powerShellSingleQuote(binary);
    const versionPart = versionArgs.map(powerShellSingleQuote).join(' ');
    const script = [
        `$ErrorActionPreference='SilentlyContinue'`,
        `$c = Get-Command ${bin}`,
        `if (-not $c) { exit ${NOT_FOUND_EXIT} }`,
        `'${PATH_SENTINEL}' + $c.Source`,
        `& ${bin} ${versionPart} 2>&1`,
    ].join('\n');
    return shellDescriptorForScript(target, script);
}
// True when this setup has a user shell the fallback probe can consult: a POSIX
// target plus a zsh/bash $SHELL (the probe script uses `command -v` + POSIX
// quoting, which fish would misparse). Exported because callers that act on a
// "not installed" verdict need to know whether the full probe chain ran: without
// the interactive fallback, an absent binary may simply be one the primary
// `bash -lc` probe cannot see.
export function userShellProbeSupported(target, shell) {
    if (target !== 'darwin' && target !== 'linux')
        return false;
    const shellPath = shell?.trim();
    if (!shellPath)
        return false;
    const shellName = shellPath.split('/').pop();
    return shellName === 'zsh' || shellName === 'bash';
}
// Fallback probe through the user's own login+interactive shell. The primary
// probe runs `bash -lc`, which never sources zsh config — so a `claude` whose
// PATH entry lives only in ~/.zshrc/~/.zprofile (nvm, homebrew) is visible in
// every PTY terminal (they spawn the user's real shell) but invisible to the
// probe when the app was launched from the Dock. Returns null when the setup
// has no such shell to consult (Windows/WSL, fish, no $SHELL), so callers
// simply keep the primary verdict.
export function buildUserShellProbeDescriptor(input) {
    const { binary, versionArgs, target, shell } = input;
    if (!userShellProbeSupported(target, shell))
        return null;
    const shellPath = shell.trim();
    const bin = posixSingleQuote(binary);
    const versionPart = versionArgs.map(posixSingleQuote).join(' ');
    // In an interactive shell `command -v` also matches aliases and functions
    // (printing the alias text or the bare name, not a path). Those cannot be
    // spawned headlessly, so the probe only accepts an absolute executable path
    // — anything else reads as not-found.
    const script = [
        `p="$(command -v ${bin})" || exit ${NOT_FOUND_EXIT}`,
        `case "$p" in /*) [ -x "$p" ] || exit ${NOT_FOUND_EXIT} ;; *) exit ${NOT_FOUND_EXIT} ;; esac`,
        `printf '${PATH_SENTINEL}%s\\n' "$p"`,
        `"$p" ${versionPart} 2>&1 || true`,
    ].join('\n');
    // -i so interactive-only config (~/.zshrc) is sourced too — that's where
    // PATH edits usually live; a PTY terminal sources the same files.
    return { file: shellPath, args: ['-ilc', script] };
}
// Builds a script that exits NOT_FOUND_EXIT when a prerequisite binary (npm,
// brew, curl, …) is absent, without invoking it.
export function buildExistsDescriptor(input) {
    const { binary, target } = input;
    if (isPosixTarget(target)) {
        const bin = posixSingleQuote(binary);
        return shellDescriptorForScript(target, `command -v ${bin} >/dev/null 2>&1 || exit ${NOT_FOUND_EXIT}`);
    }
    const bin = powerShellSingleQuote(binary);
    return shellDescriptorForScript(target, `if (-not (Get-Command ${bin} -ErrorAction SilentlyContinue)) { exit ${NOT_FOUND_EXIT} }`);
}
// Builds the descriptor that runs an install method's command verbatim in the
// target shell.
export function buildInstallDescriptor(input) {
    return shellDescriptorForScript(input.target, input.shell);
}
export function parseProbeOutput(code, stdout) {
    if (code === NOT_FOUND_EXIT) {
        return { installed: false, version: null, resolvedPath: null };
    }
    let resolvedPath = null;
    const versionLines = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (line.startsWith(PATH_SENTINEL)) {
            resolvedPath = line.slice(PATH_SENTINEL.length).trim() || null;
            continue;
        }
        versionLines.push(line);
    }
    // First non-path line that carries a version-looking token, else the first
    // line, else null.
    const version = versionLines.find((line) => /\d+\.\d+/.test(line)) ?? versionLines[0] ?? null;
    return { installed: true, version, resolvedPath };
}
function runDescriptor(desc, onData, env = process.env, 
// When set, the child is killed at the deadline and the outcome reads as
// not-found — a probe that hangs (e.g. a slow interactive shell profile)
// must never wedge the caller.
timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(desc.file, desc.args, {
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, timeoutMs)
            : null;
        const settle = (outcome) => {
            if (timer)
                clearTimeout(timer);
            resolve(outcome);
        };
        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            onData?.(text);
        });
        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            onData?.(text);
        });
        child.on('error', (error) => {
            settle({ code: 1, stdout, stderr: stderr + (error.message ?? String(error)), timedOut: false });
        });
        child.on('close', (code) => {
            if (timedOut) {
                settle({
                    code: NOT_FOUND_EXIT,
                    stdout: '',
                    stderr: `${stderr}\nprobe timed out after ${timeoutMs}ms`,
                    timedOut: true,
                });
                return;
            }
            settle({ code: code ?? 1, stdout, stderr, timedOut: false });
        });
    });
}
function resolveBinary(manifest, runtime) {
    const override = typeof runtime?.command === 'string' ? runtime.command.trim() : '';
    return override || manifest.binary;
}
// Builds the environment used to run install commands (and the post-install
// re-detect): the managed `node`/`npm` shims and the writable npm prefix bin
// are prepended to PATH so npm-based installs (e.g. Codex) work with no user
// Node, and the freshly installed binary is discoverable on the next probe.
// Returns null when no managed runtime is vendored, so callers fall back to the
// user's own PATH unchanged.
function stringProcessEnv() {
    return Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'));
}
// Probes run shells whose profiles we do not control; hard deadlines keep a
// pathological config (a ~/.bash_profile that starts tmux, prompts, or waits
// on a network mount) from wedging provider listing or availability checks.
// The primary login probe gets a longer budget than the interactive fallback.
const PROBE_TIMEOUT_MS = 10_000;
const USER_SHELL_PROBE_TIMEOUT_MS = 5_000;
function managedInstallEnv() {
    const runtimeEnv = currentRuntimeEnv();
    const shims = ensureManagedRuntimeShims(runtimeEnv);
    if (!shims)
        return null;
    const withShims = withManagedRuntimePath(stringProcessEnv(), shims.shimDir, runtimeEnv.platform);
    return withManagedRuntimePath(withShims, shims.prefixBinDir, runtimeEnv.platform);
}
// Runs the login-shell probe, then the user's own interactive shell when the
// binary did not resolve (terminal parity — see buildUserShellProbeDescriptor).
async function runVersionProbe(input) {
    const { binary, versionArgs, target, env } = input;
    const primary = await runDescriptor(buildProbeDescriptor({ binary, versionArgs, target }), undefined, env, PROBE_TIMEOUT_MS);
    let parsed = parseProbeOutput(primary.code, primary.stdout);
    let inconclusive = primary.timedOut;
    if (parsed.installed)
        return { parsed, inconclusive };
    const fallback = buildUserShellProbeDescriptor({ binary, versionArgs, target, shell: process.env.SHELL });
    if (!fallback)
        return { parsed, inconclusive };
    const outcome = await runDescriptor(fallback, undefined, env, USER_SHELL_PROBE_TIMEOUT_MS);
    const fallbackParsed = parseProbeOutput(outcome.code, outcome.stdout);
    // Only an absolute executable path is accepted (the script enforces it), so
    // an alias/function-only setup reads as not-found rather than producing a
    // resolvedPath that cannot be spawned.
    if (fallbackParsed.installed && fallbackParsed.resolvedPath?.startsWith('/')) {
        return { parsed: fallbackParsed, inconclusive: false };
    }
    if (outcome.timedOut)
        inconclusive = true;
    return { parsed, inconclusive };
}
// PATH augmentation matching what terminal launches get (managed runtime shims
// + the Multicode CLI bin dir), so a managed install is never invisible to a
// probe.
function defaultProbeEnv() {
    return withMulticodeCliPath(managedInstallEnv() ?? stringProcessEnv());
}
// Exported so the branch that keeps a killed probe out of the not-installed
// bucket is directly asserted; probeBinaryVersion is the only caller.
export function binaryVersionProbeFrom({ parsed, inconclusive }) {
    if (!parsed.installed)
        return inconclusive ? { outcome: 'probe_failed' } : { outcome: 'not_installed' };
    // Resolved without a version line means the probe ran but told us nothing
    // usable; reporting success with an empty version would put a placeholder on
    // screen.
    if (!parsed.version)
        return { outcome: 'probe_failed' };
    return { outcome: 'resolved', version: parsed.version, resolvedPath: parsed.resolvedPath };
}
export async function probeBinaryVersion(binary) {
    try {
        return binaryVersionProbeFrom(await runVersionProbe({
            binary,
            versionArgs: ['--version'],
            target: resolveInstallPlatform(process.platform, false),
            env: defaultProbeEnv(),
        }));
    }
    catch {
        return { outcome: 'probe_failed' };
    }
}
export async function detectCli(cli, runtime, env) {
    const manifest = getPluginManifest(cli);
    const useWsl = runtime?.useWsl ?? false;
    if (!manifest) {
        return {
            cli,
            binary: cli,
            installed: false,
            version: null,
            resolvedPath: null,
            useWsl,
            error: `No plugin manifest found for "${cli}".`,
        };
    }
    const binary = resolveBinary(manifest, runtime);
    const target = resolveInstallPlatform(process.platform, useWsl);
    const versionArgs = manifest.detect?.versionArgs ?? ['--version'];
    try {
        // An explicit caller env still wins over the default probe PATH.
        const { parsed } = await runVersionProbe({
            binary,
            versionArgs,
            target,
            env: env ?? defaultProbeEnv(),
        });
        return {
            cli,
            binary,
            installed: parsed.installed,
            version: parsed.version,
            resolvedPath: parsed.resolvedPath,
            useWsl,
            error: null,
        };
    }
    catch (error) {
        return {
            cli,
            binary,
            installed: false,
            version: null,
            resolvedPath: null,
            useWsl,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
async function prerequisiteAvailable(requires, target) {
    try {
        const outcome = await runDescriptor(buildExistsDescriptor({ binary: requires, target }));
        return outcome.code !== NOT_FOUND_EXIT;
    }
    catch {
        return false;
    }
}
function selectInstallMethods(manifest, target) {
    return manifest.install?.[target] ?? [];
}
export async function cliInstallMethods(cli, runtime) {
    const manifest = getPluginManifest(cli);
    if (!manifest)
        return [];
    const useWsl = runtime?.useWsl ?? false;
    const target = resolveInstallPlatform(process.platform, useWsl);
    const methods = selectInstallMethods(manifest, target);
    const infos = await Promise.all(methods.map(async (method) => {
        const available = method.requires
            ? await prerequisiteAvailable(method.requires, target)
            : true;
        return {
            id: method.id,
            label: method.label,
            available,
            unavailableReason: available || !method.requires ? null : `Requires "${method.requires}" on PATH`,
            recommended: method.recommended ?? false,
            commandPreview: method.shell,
            platform: target,
        };
    }));
    return infos;
}
export async function installCli(input, runtime, onData) {
    const manifest = getPluginManifest(input.cli);
    const useWsl = runtime?.useWsl ?? false;
    if (!manifest) {
        return {
            ok: false,
            cli: input.cli,
            installed: false,
            version: null,
            resolvedPath: null,
            log: '',
            error: `No plugin manifest found for "${input.cli}".`,
        };
    }
    const target = resolveInstallPlatform(process.platform, useWsl);
    const method = selectInstallMethods(manifest, target).find((entry) => entry.id === input.methodId);
    if (!method) {
        return {
            ok: false,
            cli: input.cli,
            installed: false,
            version: null,
            resolvedPath: null,
            log: '',
            error: `No install method "${input.methodId}" for ${input.cli} on ${target}.`,
        };
    }
    const banner = `$ ${method.shell}\n`;
    onData?.(banner);
    let log = banner;
    const capture = (chunk) => {
        log += chunk;
        onData?.(chunk);
    };
    // Run the install (and the re-detect below) with the managed node/npm on
    // PATH so npm-based installers work without a user Node and the resulting
    // binary is discoverable. Falls back to the user's PATH when no managed
    // runtime is vendored.
    const installEnv = managedInstallEnv() ?? undefined;
    let runError = null;
    try {
        const outcome = await runDescriptor(buildInstallDescriptor({ shell: method.shell, target }), capture, installEnv);
        if (outcome.code !== 0) {
            runError = `Install command exited with code ${outcome.code}.`;
        }
    }
    catch (error) {
        runError = error instanceof Error ? error.message : String(error);
    }
    // Re-detect regardless of exit code: some installers report a non-zero exit
    // while still placing the binary (e.g. PATH advisories).
    const detected = await detectCli(input.cli, runtime, installEnv);
    const ok = detected.installed && runError === null;
    return {
        ok,
        cli: input.cli,
        installed: detected.installed,
        version: detected.version,
        resolvedPath: detected.resolvedPath,
        log,
        error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after install.')),
    };
}
// Builds the descriptor that runs the CLI's own updater: the resolved binary
// with the manifest `update.args`, in the target shell so PATH resolution
// matches detection and terminal launches.
export function buildUpdateDescriptor(input) {
    const { binary, args, target } = input;
    if (isPosixTarget(target)) {
        return shellDescriptorForScript(target, [binary, ...args].map(posixSingleQuote).join(' '));
    }
    return shellDescriptorForScript(target, `& ${[binary, ...args].map(powerShellSingleQuote).join(' ')}`);
}
// Update an installed CLI (MC-1873). No staleness detection: a CLI's "latest"
// belongs to the vendor's channel, so this is an action, not a state. Where
// the manifest declares an `update` spec the CLI's own updater runs; otherwise
// the install spec is re-run, which for npm installs is exactly "update to
// latest" and no-ops when current.
export async function updateCli(cli, runtime, onData) {
    const manifest = getPluginManifest(cli);
    if (!manifest) {
        return {
            ok: false,
            cli,
            installed: false,
            version: null,
            resolvedPath: null,
            log: '',
            error: `No plugin manifest found for "${cli}".`,
        };
    }
    const target = resolveInstallPlatform(process.platform, runtime?.useWsl ?? false);
    if (manifest.update?.args?.length) {
        const binary = resolveBinary(manifest, runtime);
        const banner = `$ ${[binary, ...manifest.update.args].join(' ')}\n`;
        onData?.(banner);
        let log = banner;
        const capture = (chunk) => {
            log += chunk;
            onData?.(chunk);
        };
        const updateEnv = managedInstallEnv() ?? undefined;
        let runError = null;
        try {
            const outcome = await runDescriptor(buildUpdateDescriptor({ binary, args: manifest.update.args, target }), capture, updateEnv);
            if (outcome.code !== 0) {
                runError = `Update command exited with code ${outcome.code}.`;
            }
        }
        catch (error) {
            runError = error instanceof Error ? error.message : String(error);
        }
        const detected = await detectCli(cli, runtime, updateEnv);
        const ok = detected.installed && runError === null;
        return {
            ok,
            cli,
            installed: detected.installed,
            version: detected.version,
            resolvedPath: detected.resolvedPath,
            log,
            error: ok ? null : (runError ?? (detected.installed ? null : 'CLI not found on PATH after update.')),
        };
    }
    const methods = await cliInstallMethods(cli, runtime);
    const method = methods.find((entry) => entry.recommended && entry.available)
        ?? methods.find((entry) => entry.available)
        ?? methods[0];
    if (!method) {
        return {
            ok: false,
            cli,
            installed: false,
            version: null,
            resolvedPath: null,
            log: '',
            error: `No update path for ${cli} on ${target}: the manifest declares no update spec and no install methods.`,
        };
    }
    return installCli({ cli, methodId: method.id }, runtime, onData);
}
