import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { posix as posixPath, win32 as windowsPath } from 'node:path';
import { FOLDER_OPEN_TARGET_IDS, isFolderOpenTargetId, } from '../../shared/folder-open-targets';
const EDITOR_LAUNCHERS = {
    vscode: {
        cliNames: ['code'],
        macAppNames: ['Visual Studio Code.app'],
    },
    intellij: {
        cliNames: ['idea'],
        macAppNames: ['IntelliJ IDEA.app', 'IntelliJ IDEA Community Edition.app'],
    },
};
const TARGET_NAMES = {
    vscode: 'VS Code',
    intellij: 'IntelliJ IDEA',
    finder: 'the file manager',
};
// A launcher that has not exited by this point started the editor: `code`,
// `idea` and `open` all return immediately, so a still-running child means the
// binary resolved and is doing its work. Only an exit failure or a spawn error
// is reported as a failed launch.
const LAUNCH_SETTLE_MS = 5_000;
/**
 * The editor probe, as a plain call. Shared by the `fs:folder-open-targets`
 * handler and the boot-discovery pass so both answer "which editors are
 * installed" the same way. Cheap and synchronous — it walks PATH and
 * /Applications with `existsSync` and spawns nothing — so it needs no cache.
 */
export function listFolderOpenTargetAvailability(resolveLauncher) {
    return FOLDER_OPEN_TARGET_IDS.map((id) => ({ id, available: resolveLauncher(id) !== null }));
}
/** `resolveFolderOpenLauncher` against the real machine. */
export function resolveFolderOpenLauncherHere(target) {
    return resolveFolderOpenLauncher(target, { platform: process.platform, env: process.env, exists: existsSync });
}
export function registerFolderOpenIpc(ipcMain, deps) {
    ipcMain.handle('fs:folder-open-targets', async () => {
        return listFolderOpenTargetAvailability(deps.resolveLauncher);
    });
    ipcMain.handle('fs:open-folder-in-target', async (_, request) => {
        const target = request?.target;
        if (!isFolderOpenTargetId(target)) {
            return { ok: false, target: null, reason: 'unknown_target', message: `Unknown open target: ${String(target)}.` };
        }
        const folderPath = typeof request?.path === 'string' ? request.path : '';
        if (!folderPath.trim()) {
            return { ok: false, target, reason: 'path_unavailable', message: 'No folder was given to open.' };
        }
        try {
            await deps.assertPathReachable(folderPath);
        }
        catch (error) {
            return { ok: false, target, reason: 'path_unavailable', message: describeError(error) };
        }
        // Resolved again at launch time rather than trusted from the probe: an
        // editor can be uninstalled between the menu opening and the click.
        const launcher = deps.resolveLauncher(target);
        if (!launcher) {
            return { ok: false, target, reason: 'target_unavailable', message: `${TARGET_NAMES[target]} is not installed.` };
        }
        if (launcher.kind === 'reveal') {
            try {
                await deps.showItemInFolder(folderPath);
                return { ok: true, target };
            }
            catch (error) {
                return { ok: false, target, reason: 'launch_failed', message: describeError(error) };
            }
        }
        // A spawn that cannot even start (a rejected launcher call) is still a
        // launch failure the caller must see, not a rejected invoke it has to catch.
        let outcome;
        try {
            outcome = await deps.runLauncher(launcher.command, [...launcher.args, folderPath]);
        }
        catch (error) {
            return { ok: false, target, reason: 'launch_failed', message: describeError(error) };
        }
        if (!outcome.ok) {
            return { ok: false, target, reason: 'launch_failed', message: outcome.message };
        }
        return { ok: true, target };
    });
}
export function createFolderOpenIpcDependencies(showItemInFolder) {
    return {
        showItemInFolder,
        resolveLauncher: resolveFolderOpenLauncherHere,
        runLauncher: (command, args) => runLauncher(command, args, LAUNCH_SETTLE_MS),
        assertPathReachable: (targetPath) => access(targetPath),
    };
}
/**
 * The single source of truth for both channels: availability is "this returns a
 * launcher", so the menu can never offer an editor the open action would fail
 * to start. The file manager always resolves.
 */
export function resolveFolderOpenLauncher(target, probe) {
    if (target === 'finder')
        return { kind: 'reveal' };
    const spec = EDITOR_LAUNCHERS[target];
    for (const cliName of spec.cliNames) {
        const resolved = findOnPath(cliName, probe);
        if (resolved)
            return commandLauncher(resolved, [], probe);
    }
    const appBundle = findMacApp(spec.macAppNames, probe);
    if (appBundle)
        return { kind: 'command', command: '/usr/bin/open', args: ['-a', appBundle] };
    return null;
}
function findOnPath(name, probe) {
    const isWindows = probe.platform === 'win32';
    const pathValue = probe.env.PATH ?? probe.env.Path ?? '';
    const candidateNames = isWindows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
    const joinPath = isWindows ? windowsPath.join : posixPath.join;
    for (const dir of pathValue.split(isWindows ? ';' : ':')) {
        if (!dir)
            continue;
        for (const candidateName of candidateNames) {
            const candidate = joinPath(dir, candidateName);
            if (probe.exists(candidate))
                return candidate;
        }
    }
    return null;
}
function findMacApp(appNames, probe) {
    if (probe.platform !== 'darwin')
        return null;
    const home = probe.env.HOME ?? '';
    const searchDirs = home ? ['/Applications', posixPath.join(home, 'Applications')] : ['/Applications'];
    for (const dir of searchDirs) {
        for (const appName of appNames) {
            const candidate = posixPath.join(dir, appName);
            if (probe.exists(candidate))
                return candidate;
        }
    }
    return null;
}
// Windows ships the editor CLIs as `.cmd`/`.bat` shims, which cannot be spawned
// directly; the command processor runs them, with the path still a separate
// argv element rather than concatenated shell text.
function commandLauncher(command, args, probe) {
    if (probe.platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
        return { kind: 'command', command, args };
    }
    return { kind: 'command', command: probe.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
}
function runLauncher(command, args, settleMs) {
    return new Promise((resolve) => {
        let settled = false;
        let settleTimer;
        const settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(settleTimer);
            resolve(outcome);
        };
        let child;
        try {
            child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
        }
        catch (error) {
            settle({ ok: false, message: describeError(error) });
            return;
        }
        settleTimer = setTimeout(() => settle({ ok: true }), settleMs);
        child.on('error', (error) => settle({ ok: false, message: describeError(error) }));
        child.on('close', (code) => {
            settle(code === 0 ? { ok: true } : { ok: false, message: `${command} exited with code ${String(code)}.` });
        });
        child.unref();
    });
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
