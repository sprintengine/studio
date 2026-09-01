// Safety detector for the idle reaper: before suspending/disposing an idle
// agent terminal, confirm there is nothing live running under its pty. Killing
// the terminal kills the CLI process, and the CLI's shutdown kills every
// background task it is tracking — so reaping a session with live background
// work aborts that work mid-flight (the resumed session then reports "No
// completion record was found for this background shell command").
//
// Three signals mark a subtree as holding live work:
//   1. A LISTENING TCP socket held by any subtree process — dev servers
//      (vite/webpack/next/…) hold a port, while stdio MCP servers do NOT, so
//      this doesn't false-positive on the MCP helpers every agent spawns.
//   2. A subtree process burning CPU — catches a busy non-server command (a
//      build/test) that holds no port.
//   3. A Claude Code tool shell (`~/.claude/shell-snapshots/…` wrapper) — the
//      signature of every shell the agent's Bash tool runs, foreground or
//      `run_in_background`. This is what protects the quiet waiters signals 1
//      and 2 cannot see: a backgrounded `sleep`/poll/blocked-on-IO shell burns
//      ~0% CPU and holds no port, but killing the CLI still kills it. MCP
//      helpers never match it, so idle sessions stay reapable.
//
// Pure core (testable without spawning); the OS reads (`ps`, `lsof`) are
// injected. Runs once per sweep over the small set of reap candidates, not per
// process, so the cost is two subprocesses regardless of candidate count. Any
// failure resolves to "live" (keep the terminal alive) — never the reverse.
import { execFile } from 'node:child_process';
// A subtree process above this CPU share counts as "doing work" → keep alive.
// High enough to ignore idle MCP/helper jitter, low enough to catch a build.
export const SUBTREE_BUSY_CPU_PERCENT = 15;
// Every shell the Claude Code Bash tool runs — foreground or backgrounded —
// sources its snapshot from this directory, making it a precise marker for
// "the agent has a shell command in flight" that idle MCP servers never match.
export const CLAUDE_TOOL_SHELL_SIGNATURE = '.claude/shell-snapshots/';
export function parsePsTree(stdout) {
    const rows = [];
    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (!line)
            continue;
        const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
        if (!match)
            continue;
        rows.push({
            pid: Number(match[1]),
            ppid: Number(match[2]),
            cpuPercent: Number(match[3]),
            command: match[4],
        });
    }
    return rows;
}
// `lsof -t` prints one pid per line. A pid may repeat (multiple sockets); a Set
// dedups.
export function parseListeningPids(stdout) {
    const pids = new Set();
    for (const raw of stdout.split('\n')) {
        const value = Number(raw.trim());
        if (Number.isInteger(value) && value > 0)
            pids.add(value);
    }
    return pids;
}
// The first live-work reason found in `rootPid`'s descendant tree, or null when
// the subtree holds nothing live. The root itself (the pty shell) is not
// counted — we are asking whether something the shell launched is still live.
export function subtreeLiveReason(rootPid, procs, listeningPids, options = {}) {
    const busyCpuPercent = options.busyCpuPercent ?? SUBTREE_BUSY_CPU_PERCENT;
    const childrenByParent = new Map();
    for (const proc of procs) {
        const list = childrenByParent.get(proc.ppid);
        if (list)
            list.push(proc);
        else
            childrenByParent.set(proc.ppid, [proc]);
    }
    const seen = new Set([rootPid]);
    const stack = [...(childrenByParent.get(rootPid) ?? [])];
    while (stack.length > 0) {
        const proc = stack.pop();
        if (seen.has(proc.pid))
            continue;
        seen.add(proc.pid);
        if (listeningPids.has(proc.pid))
            return 'listening_port';
        if (proc.cpuPercent > busyCpuPercent)
            return 'busy_cpu';
        if (proc.command.includes(CLAUDE_TOOL_SHELL_SIGNATURE))
            return 'tool_shell';
        const children = childrenByParent.get(proc.pid);
        if (children)
            stack.push(...children);
    }
    return null;
}
export function subtreeHasLiveProcess(rootPid, procs, listeningPids, options = {}) {
    return subtreeLiveReason(rootPid, procs, listeningPids, options) !== null;
}
// Resolves to null on any error so the caller can tell "command failed" apart
// from "command ran and returned nothing" — critical because an empty `lsof`
// result must NOT be read as "no servers" when lsof simply failed/was missing.
function execFileTextOrNull(command, args) {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
    });
}
// Resolves each root pid to the live-work reason found in its subtree (null =
// probed clean, safe to reap). A root absent from the returned map (or any
// failure) means "undetermined" — callers MUST treat that as live/keep-alive.
export async function probeSubtreesForLiveWork(rootPids, deps = {}) {
    const platform = deps.platform ?? process.platform;
    const result = new Map();
    if (rootPids.length === 0)
        return result;
    if (platform !== 'darwin' && platform !== 'linux')
        return result; // undetermined → keep-alive
    const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']));
    const runLsofListening = deps.runLsofListening ?? (() => execFileTextOrNull('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-t']));
    try {
        const [psOut, lsofOut] = await Promise.all([runPs(), runLsofListening()]);
        // If EITHER read failed, we can't trust the result — an empty lsof would be
        // misread as "no servers". Leave every root undetermined → keep-alive.
        if (psOut === null || lsofOut === null)
            return result;
        const procs = parsePsTree(psOut);
        if (procs.length === 0)
            return result; // ps yielded nothing usable → undetermined
        const listening = parseListeningPids(lsofOut);
        for (const rootPid of rootPids) {
            result.set(rootPid, subtreeLiveReason(rootPid, procs, listening));
        }
    }
    catch {
        return new Map(); // undetermined → keep-alive
    }
    return result;
}
// Boolean projection kept for callers that only need live/not-live.
export async function probeSubtreesForLiveProcesses(rootPids, deps = {}) {
    const reasons = await probeSubtreesForLiveWork(rootPids, deps);
    const result = new Map();
    for (const [pid, reason] of reasons)
        result.set(pid, reason !== null);
    return result;
}
// A CLI process that outlives its terminal teardown. The pty kill reaches the
// shell, but a CLI child that survives the resulting SIGHUP reparents to
// launchd and nothing tracks it afterwards — the 2026-07-26 incident leaked 15
// idle Opus agents this way. The one durable handle on such a process is its
// own argv: agent CLIs are launched with an explicit `--session-id <uuid>`,
// which survives reparenting and cannot collide.
export function matchCliSessionPids(psOutput, cliSessionId) {
    if (!cliSessionId)
        return [];
    const needle = `--session-id ${cliSessionId}`;
    const pids = [];
    for (const line of psOutput.split('\n')) {
        if (!line.includes(needle))
            continue;
        const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
        if (Number.isFinite(pid) && pid > 0)
            pids.push(pid);
    }
    return pids;
}
/**
 * Post-teardown escalation: after the pty kill has had `delayMs` to propagate,
 * SIGKILL any process still carrying this terminal's `--session-id`. Callers
 * fire-and-forget it right after the kill; a clean exit means the ps sweep
 * finds nothing and this is a no-op. Returns the pids it killed (for tests
 * and audit).
 */
export async function killCliSessionSurvivors(cliSessionId, deps = {}) {
    if (!cliSessionId)
        return [];
    const platform = deps.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'linux')
        return [];
    const delayMs = deps.delayMs ?? 2_000;
    if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    const runPs = deps.runPs ?? (() => execFileTextOrNull('ps', ['-axo', 'pid=,ppid=,pcpu=,args=']));
    const psOut = await runPs();
    if (psOut === null)
        return []; // undetermined — never kill on a failed read
    const killImpl = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    const killed = [];
    for (const pid of matchCliSessionPids(psOut, cliSessionId)) {
        try {
            killImpl(pid, 'SIGKILL');
            killed.push(pid);
        }
        catch {
            // Already gone between the ps read and the kill — the goal state.
        }
    }
    return killed;
}
