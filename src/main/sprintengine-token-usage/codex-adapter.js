import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../filesystem-workspace';
import { forEachJsonlRow } from './jsonl';
import { tokenCount, withDerivedTotals } from './types';
// sessionsDir-scoped so CODEX_HOME overrides (and tests) never cross-hit.
const rolloutPathBySession = new Map();
const parsedByRollout = new Map();
function resolveSessionsDir(homeDir, env) {
    const override = env.CODEX_HOME?.trim();
    const codexHome = override || path.join(homeDir, '.codex');
    return path.join(codexHome, 'sessions');
}
// Depth-first search for the rollout whose filename ends with the session id.
// The session id is embedded in the filename, but the YYYY/MM/DD path is not
// derivable from the id alone, so the date tree is walked until the file is hit.
async function findRolloutFile(dir, cliSessionId) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const suffix = `-${cliSessionId}.jsonl`;
    const subdirs = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            subdirs.push(path.join(dir, entry.name));
        }
        else if (entry.isFile() &&
            entry.name.startsWith('rollout-') &&
            entry.name.endsWith(suffix)) {
            return path.join(dir, entry.name);
        }
    }
    // Walk newest-first: sprint sessions are recent, so the target date dir is
    // near the end of the lexicographic YYYY/MM/DD order.
    subdirs.sort().reverse();
    for (const subdir of subdirs) {
        const found = await findRolloutFile(subdir, cliSessionId);
        if (found)
            return found;
    }
    return null;
}
async function locateRollout(sessionsDir, cliSessionId) {
    const memoKey = `${sessionsDir} ${cliSessionId}`;
    const memoized = rolloutPathBySession.get(memoKey);
    if (memoized && (await pathExists(memoized)))
        return memoized;
    const found = await findRolloutFile(sessionsDir, cliSessionId);
    if (found)
        rolloutPathBySession.set(memoKey, found);
    return found;
}
function readTotal(payload) {
    return payload.info?.total_token_usage ?? payload.total_token_usage ?? null;
}
// Returns null when no rollout file or no token_count event exists for the
// session (caller reports measured:false); otherwise a single-model entry built
// from the last cumulative reading.
export async function readCodexUsage(cliSessionId, homeDir, env) {
    const rolloutFile = await locateRollout(resolveSessionsDir(homeDir, env), cliSessionId);
    if (!rolloutFile)
        return null;
    let statKey;
    try {
        const info = await stat(rolloutFile);
        statKey = `${info.mtimeMs}:${info.size}`;
    }
    catch {
        return null;
    }
    const memoized = parsedByRollout.get(rolloutFile);
    if (memoized && memoized.statKey === statKey) {
        return memoized.rows.map((row) => ({ ...row }));
    }
    let lastTotal = null;
    let lastModel = 'unknown';
    await forEachJsonlRow(rolloutFile, (parsed) => {
        const row = parsed;
        const payload = row.payload;
        if (!payload || typeof payload !== 'object')
            return;
        if (row.type === 'turn_context' && typeof payload.model === 'string') {
            lastModel = payload.model;
        }
        if (payload.type === 'token_count') {
            const total = readTotal(payload);
            if (total)
                lastTotal = total;
        }
    });
    // A located, parseable rollout with no populated token_count yet is a REAL
    // zero reading (a session that has done no work), not an unreadable source —
    // report it measured-with-no-rows so coverage stays truthful.
    if (!lastTotal) {
        const rows = [];
        parsedByRollout.set(rolloutFile, { statKey, rows });
        return rows;
    }
    const found = lastTotal;
    const rawInput = tokenCount(found.input_tokens);
    const cacheRead = tokenCount(found.cached_input_tokens);
    const derived = withDerivedTotals([
        {
            model: lastModel,
            // Codex input includes cached input; store the non-cached remainder so
            // `input` has the same meaning as Claude Code's disjoint fields.
            input: Math.max(0, rawInput - cacheRead),
            output: tokenCount(found.output_tokens),
            cacheRead,
            cacheCreation: 0,
            total: 0,
            split: true,
        },
    ]);
    // Cross-check against the rollout's own session total: if a Codex release
    // ever changes the cache-inclusion semantics the derived components would
    // skew, but the headline total stays pinned to Codex's own accounting —
    // minus the cached re-reads it folds in, which sit outside `total` here the
    // same way they do for every other CLI (see withDerivedTotals).
    const reportedTotal = tokenCount(found.total_tokens);
    const rows = reportedTotal > 0
        ? derived.map((row) => ({ ...row, total: Math.max(0, reportedTotal - cacheRead) }))
        : derived;
    parsedByRollout.set(rolloutFile, { statKey, rows });
    return rows.map((row) => ({ ...row }));
}
