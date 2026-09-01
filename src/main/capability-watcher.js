// Keeping `agentCapabilities` true to disk while a surface stays open.
//
// The docked Skills pane lives for hours while the very agent it describes
// writes into the directories it reads, so refetch-on-open (the picker's
// strategy) would show a snapshot from whenever the workspace was opened —
// which looks live and is not. This watches the paths the resolver actually
// resolved and emits *invalidation*: `{ workspaceRoot, harnessId, pluginIds }`,
// never a payload. Pushing the list would make this a second source of truth
// for the same query.
//
// No polling anywhere: `fs.watch` only, never `fs.watchFile` (which polls) and
// never an interval. The one timer is the coalescing debounce.
import { existsSync, watch } from 'fs';
import { basename, dirname, join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { buildHarnessMap } from '../shared/harness-map';
import { resolveMcpConfigPath } from './mcp-config-service';
/**
 * An install writes many files; one skill directory appearing is several
 * events. Long enough to coalesce a `git checkout`, short enough that the pane
 * moves while the user is still looking at the terminal that caused it.
 */
const INVALIDATE_DEBOUNCE_MS = 250;
/**
 * Watching is per open workspace and each workspace costs a handful of OS
 * watch handles. Beyond this the cap is stated rather than applied silently:
 * the workspace is subscribed, watches nothing, and says so in `diagnostics`.
 */
const MAX_WATCHED_WORKSPACES = 8;
export function createFsWatchDirectory() {
    return (target, onChange) => {
        const start = (recursive) => watch(target.path, { recursive }, (_event, filename) => onChange(typeof filename === 'string' ? filename : null));
        // Recursive is supported on macOS and Windows and is what catches an edit
        // to an existing skill's SKILL.md rather than only the directory appearing.
        // Asked for only where the caller wants a tree — never for the workspace
        // root, which a config file's parent directory watch lands on.
        if (!target.recursive)
            return start(false);
        try {
            return start(true);
        }
        catch {
            return start(false);
        }
    };
}
export function createCapabilityWatcher(options) {
    const watchDirectory = options.watchDirectory ?? createFsWatchDirectory();
    const pathExists = options.pathExists ?? ((path) => existsSync(path));
    const homeDir = options.homeDir ?? (() => homedir());
    const debounceMs = options.debounceMs ?? INVALIDATE_DEBOUNCE_MS;
    const maxWorkspaces = options.maxWorkspaces ?? MAX_WATCHED_WORKSPACES;
    const log = options.log ?? ((message) => console.warn(`[capability-watcher] ${message}`));
    const workspaces = new Map();
    let releaseFocus = null;
    const emit = (workspace, group) => {
        const event = {
            workspaceRoot: workspace.root,
            harnessId: group.group.harnessId,
            pluginIds: group.group.pluginIds,
        };
        for (const subscription of [...workspace.listeners])
            subscription.notify(event);
    };
    const schedule = (workspace, group) => {
        if (group.timer)
            clearTimeout(group.timer);
        group.timer = setTimeout(() => {
            group.timer = null;
            // A watched directory that has been deleted takes its watch with it: the
            // handle stays open and silently stops delivering, and `attach` skips the
            // entry because it still holds one. Recreating the directory would then
            // never be noticed, and nothing would say so — the pane would look live
            // and be frozen. Checked once per debounced burst, not per event.
            dropWatchesOnMissingPaths(group);
            if (!workspace.capped)
                attach(workspace, group);
            emit(workspace, group);
        }, debounceMs);
    };
    /**
     * Close the handles of real targets whose path has gone. Only real targets: a
     * stand-in is already watching a parent for a path that does not exist, which
     * is its whole job.
     */
    const dropWatchesOnMissingPaths = (group) => {
        for (const entry of group.targets) {
            if (!entry.handle || entry.waitingFor || pathExists(entry.path))
                continue;
            entry.handle.close();
            entry.handle = null;
        }
    };
    // Attaches every target a group still lacks a handle for, and records the
    // ones that would not start. Called on subscribe and again whenever a
    // stand-in watch reports the missing segment appearing, so a skills directory
    // created later is watched without anything polling for it.
    const attach = (workspace, group) => {
        // Index rather than for-of: a missing path appends its stand-in, and the
        // stand-in must be attached in the same pass.
        const attached = [];
        for (let index = 0; index < group.targets.length; index += 1) {
            const entry = group.targets[index];
            if (entry.handle)
                continue;
            try {
                entry.handle = watchDirectory({ path: entry.path, recursive: entry.recursive }, (filename) => {
                    if (entry.match && filename !== null && filename !== entry.match)
                        return;
                    // A stand-in fires because the path it waits for may now exist:
                    // re-attach before invalidating, so the next change is caught by
                    // the real watch rather than by this fallback.
                    if (entry.waitingFor)
                        attach(workspace, group);
                    schedule(workspace, group);
                });
                entry.failure = null;
                attached.push(entry.path);
            }
            catch (error) {
                // The path does not exist yet — the normal state of `.claude/skills`
                // before any skill is installed. Watch the nearest existing ancestor
                // for the one segment we are waiting on rather than calling it a fault.
                const standIn = isMissingPath(error) ? standInTarget(entry) : null;
                if (standIn) {
                    if (!group.targets.some((existing) => sameTarget(existing, standIn)))
                        group.targets.push(standIn);
                    continue;
                }
                entry.failure = {
                    capability: 'freshness',
                    reason: 'watch_unavailable',
                    path: entry.path,
                    message: `${formatError(error)} Changes here are picked up when the window regains focus.`,
                };
            }
        }
        // After the pass, so the loop above is not walking an array being filtered.
        for (const path of attached)
            retireStandIns(group, path);
    };
    const startWatching = (workspace) => {
        if (workspaces.size > maxWorkspaces) {
            log(`watching ${maxWorkspaces} workspaces already; ${workspace.root} is not watched and refreshes on focus instead.`);
            workspace.capped = true;
            return;
        }
        for (const group of workspace.groups)
            attach(workspace, group);
    };
    const stopWatching = (workspace) => {
        for (const group of workspace.groups) {
            if (group.timer)
                clearTimeout(group.timer);
            group.timer = null;
            for (const target of group.targets) {
                target.handle?.close();
                target.handle = null;
            }
        }
    };
    // The declared fallback: `fs.watch` is unreliable on network mounts and in
    // some containers, so a workspace with any target we could not watch — or one
    // past the cap — refetches when the window regains focus. Honest rather than
    // silent: the same condition is in `diagnostics`.
    const onFocus = () => {
        for (const workspace of workspaces.values()) {
            for (const group of workspace.groups) {
                if (!workspace.capped && !group.targets.some((target) => target.failure))
                    continue;
                if (!workspace.capped)
                    attach(workspace, group);
                emit(workspace, group);
            }
        }
    };
    return {
        subscribe(workspaceRoot, onInvalidate) {
            const root = workspaceKey(workspaceRoot);
            let workspace = workspaces.get(root);
            if (!workspace) {
                workspace = {
                    // The string the subscriber sent, not the map key: it is echoed back
                    // in every invalidation and the renderer matches it against the
                    // workspace root it holds.
                    root: workspaceRoot.trim(),
                    listeners: new Set(),
                    capped: false,
                    groups: capabilityWatchGroups({
                        plugins: options.listPlugins(),
                        lookupManifest: options.lookupManifest,
                        workspaceRoot: root,
                        homeDir,
                    }).map((group) => ({ group, targets: watchTargets(group), timer: null })),
                };
                workspaces.set(root, workspace);
                startWatching(workspace);
                if (!releaseFocus && options.onWorkspaceFocus)
                    releaseFocus = options.onWorkspaceFocus(onFocus);
            }
            // One entry per subscription, not per function: two consumers that happen
            // to pass the same callback are two subscribers, and a Set of functions
            // would collapse them and tear the watchers down under the second one.
            const subscription = { notify: onInvalidate };
            workspace.listeners.add(subscription);
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                const watched = workspaces.get(root);
                if (!watched)
                    return;
                watched.listeners.delete(subscription);
                if (watched.listeners.size > 0)
                    return;
                stopWatching(watched);
                workspaces.delete(root);
                if (workspaces.size === 0 && releaseFocus) {
                    releaseFocus();
                    releaseFocus = null;
                }
            };
        },
        invalidate(workspaceRoot, harnessId) {
            const workspace = workspaces.get(workspaceKey(workspaceRoot));
            // Nobody is subscribed for this workspace, so there is no surface holding
            // a stale answer to correct.
            if (!workspace)
                return;
            for (const group of workspace.groups) {
                if (group.group.harnessId === harnessId)
                    schedule(workspace, group);
            }
        },
        diagnosticsFor(workspaceRoot, pluginId) {
            const workspace = workspaces.get(workspaceKey(workspaceRoot));
            if (!workspace)
                return [];
            const diagnostics = [];
            for (const group of workspace.groups) {
                if (!group.group.pluginIds.includes(pluginId))
                    continue;
                if (workspace.capped) {
                    diagnostics.push({
                        capability: 'freshness',
                        reason: 'watch_unavailable',
                        path: workspace.root,
                        message: `Watching ${maxWorkspaces} workspaces already. This list refreshes when the window regains focus.`,
                    });
                    continue;
                }
                for (const target of group.targets) {
                    if (target.failure)
                        diagnostics.push(target.failure);
                }
            }
            return diagnostics;
        },
    };
}
/**
 * The paths to watch for one workspace, derived from the same harness map and
 * the same manifests the resolver reads — never a hardcoded list, so a
 * thirteenth CLI is watched with no edit here.
 */
export function capabilityWatchGroups(input) {
    const { byHarness, byPlugin } = buildHarnessMap(input.plugins);
    const groups = new Map();
    for (const binding of byHarness.values()) {
        groups.set(binding.harnessId, {
            harnessId: binding.harnessId,
            pluginIds: [...binding.pluginIds],
            // A harness declared unsupported by every CLI bound to it is never read,
            // so there is nothing to keep fresh.
            skillsDir: binding.support !== 'unsupported' && binding.skillsDir
                ? join(input.workspaceRoot, ...binding.skillsDir.split('/'))
                : null,
            configFiles: [],
        });
    }
    for (const plugin of input.plugins) {
        const spec = input.lookupManifest(plugin.id)?.mcpConfig;
        if (!spec)
            continue;
        const harnessId = byPlugin.get(plugin.id)?.harnessId;
        // A CLI declaring an MCP config and no skill integration (cursor) is its own
        // group: there is no harness to fold it into, and folding it into another
        // CLI's would refetch the wrong query.
        const key = harnessId ?? `plugin:${plugin.id}`;
        let group = groups.get(key);
        if (!group) {
            group = { harnessId: '', pluginIds: [plugin.id], skillsDir: null, configFiles: [] };
            groups.set(key, group);
        }
        for (const scope of ['workspace', 'user']) {
            const path = resolveMcpConfigPath(spec, scope, input.workspaceRoot, input.homeDir);
            if (path && !group.configFiles.includes(path))
                group.configFiles.push(path);
        }
    }
    return [...groups.values()].filter((group) => group.skillsDir || group.configFiles.length > 0);
}
function watchTargets(group) {
    const targets = [];
    if (group.skillsDir) {
        // The directory, not each skill: a skill created outside Multicode is a new
        // entry in it. Recursive so an edit to an existing SKILL.md counts too.
        targets.push(target(group.skillsDir, { recursive: true }));
    }
    for (const file of group.configFiles) {
        targets.push(target(file, {}));
        // An editor saving through a temp file and a rename replaces the inode and
        // silently drops the file watch, so the parent directory is watched for
        // this one name as well. Never recursive: for `{{workspaceRoot}}/.mcp.json`
        // the parent is the workspace root.
        targets.push(target(dirname(file), { match: basename(file) }));
    }
    return dedupeTargets(targets);
}
function target(path, options) {
    return {
        path,
        recursive: options.recursive ?? false,
        match: options.match ?? null,
        waitingFor: options.waitingFor ?? null,
        handle: null,
        failure: null,
    };
}
/**
 * A watch on the parent of a path that does not exist yet, listening for the
 * one missing segment. Walks up until it reaches a directory that does exist —
 * `.claude/skills` in a workspace with no `.claude` at all is normal, and
 * reporting either level as a fault would be wrong.
 */
function standInTarget(missing) {
    const parent = dirname(missing.path);
    if (parent === missing.path || parent === '')
        return null;
    return target(parent, {
        match: basename(missing.path),
        waitingFor: missing.waitingFor ?? missing.path,
    });
}
/** Once the real path is watched, the stand-ins waiting for it have no job. */
function retireStandIns(group, path) {
    group.targets = group.targets.filter((entry) => {
        if (entry.waitingFor !== path)
            return true;
        entry.handle?.close();
        return false;
    });
}
function sameTarget(a, b) {
    return a.path === b.path && a.recursive === b.recursive && a.match === b.match;
}
function dedupeTargets(targets) {
    const kept = [];
    for (const entry of targets) {
        if (!kept.some((existing) => sameTarget(existing, entry)))
            kept.push(entry);
    }
    return kept;
}
/**
 * One spelling of a workspace root for the subscription map. The installer
 * resolves its root before invalidating, so a subscription keyed on the raw
 * string would miss — silently, which is the worst way for freshness to fail.
 */
function workspaceKey(workspaceRoot) {
    const trimmed = workspaceRoot.trim();
    return trimmed ? resolvePath(trimmed) : trimmed;
}
function isMissingPath(error) {
    return error?.code === 'ENOENT';
}
function formatError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.endsWith('.') ? message : `${message}.`;
}
