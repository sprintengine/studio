import { execFile } from 'node:child_process';
import { parsePsProcessRows } from './child-process-metrics';
// Per-workspace memory attribution for the diagnostics panel. The flat
// child-process sampler walks the whole tree under main with no session mapping;
// this module instead walks each terminal's pty subtree from its root pid and
// sums RSS, then groups by workspaceId. It lives in main because that's the only
// place the `ps` tree and the live terminal sessions (which hold the root pids)
// meet — the renderer snapshot omits pids.
export const WORKSPACE_MEMORY_SAMPLE_THROTTLE_MS = 5_000;
// RSS of a pid's whole subtree, inclusive of the root. Terminal subtrees are
// disjoint (each pty is its own process tree), so summing per terminal never
// double-counts across terminals.
export function sumSubtreeRssBytes(rootPid, rows) {
    const childrenByParent = new Map();
    const byPid = new Map();
    for (const row of rows) {
        byPid.set(row.pid, row);
        const siblings = childrenByParent.get(row.ppid) ?? [];
        siblings.push(row);
        childrenByParent.set(row.ppid, siblings);
    }
    let totalKb = 0;
    const seen = new Set([rootPid]);
    const root = byPid.get(rootPid);
    if (root)
        totalKb += Math.max(0, root.rssKb);
    const stack = [rootPid];
    while (stack.length > 0) {
        const pid = stack.pop();
        for (const child of childrenByParent.get(pid) ?? []) {
            if (seen.has(child.pid))
                continue;
            seen.add(child.pid);
            totalKb += Math.max(0, child.rssKb);
            stack.push(child.pid);
        }
    }
    return totalKb * 1024;
}
// Pure: turn live terminal roots + a `ps` snapshot into per-workspace samples,
// heaviest first. Sessions with no workspace are skipped (cannot be attributed).
export function rollupWorkspaceMemory(roots, rows) {
    const byWorkspace = new Map();
    for (const root of roots) {
        if (root.workspaceId === null)
            continue;
        const memoryBytes = sumSubtreeRssBytes(root.rootPid, rows);
        const terminal = {
            sessionId: root.sessionId,
            kind: root.kind,
            cli: root.cli,
            agentId: root.agentId,
            terminalId: root.terminalId,
            activityKind: root.activityKind,
            processAlive: root.processAlive,
            memoryBytes,
            startedAt: root.startedAt,
        };
        let sample = byWorkspace.get(root.workspaceId);
        if (!sample) {
            sample = {
                workspaceId: root.workspaceId,
                resident: false,
                totalMemoryBytes: 0,
                becameLiveAt: null,
                terminals: [],
            };
            byWorkspace.set(root.workspaceId, sample);
        }
        sample.terminals.push(terminal);
        sample.totalMemoryBytes += memoryBytes;
        if (root.processAlive) {
            if (root.kind === 'agent')
                sample.resident = true;
            sample.becameLiveAt =
                sample.becameLiveAt === null ? root.startedAt : Math.min(sample.becameLiveAt, root.startedAt);
        }
    }
    const result = [...byWorkspace.values()];
    for (const sample of result)
        sample.terminals.sort((a, b) => b.memoryBytes - a.memoryBytes);
    result.sort((a, b) => b.totalMemoryBytes - a.totalMemoryBytes || a.workspaceId.localeCompare(b.workspaceId));
    return result;
}
export async function sampleWorkspaceMemory(roots, deps = {}) {
    const platform = deps.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'linux')
        return [];
    if (roots.length === 0)
        return [];
    const runPs = deps.runPs ?? defaultRunPs;
    try {
        return rollupWorkspaceMemory(roots, parsePsProcessRows(await runPs()));
    }
    catch {
        return [];
    }
}
function defaultRunPs() {
    return new Promise((resolve) => {
        execFile('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm=,args='], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout));
    });
}
