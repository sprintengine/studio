import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withDerivedTotals } from './types';
export function tokenLedgerPath(statePath) {
    return path.join(path.dirname(statePath), 'metrics', 'token-usage.jsonl');
}
// Monotonic per-run write counter, bumped on every append in this process.
// Report caches key their entries on it so a teardown/session-end sample
// invalidates any cached report immediately instead of waiting out a TTL.
const ledgerVersions = new Map();
export function tokenLedgerVersion(statePath) {
    return ledgerVersions.get(tokenLedgerPath(statePath)) ?? 0;
}
export async function appendTokenLedgerRecord(statePath, record) {
    const ledgerPath = tokenLedgerPath(statePath);
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
    ledgerVersions.set(ledgerPath, (ledgerVersions.get(ledgerPath) ?? 0) + 1);
}
// Fold the append-only ledger into one entry per (agentId, cliSessionId),
// keeping the latest sample. Missing file -> empty (old runs never break).
export async function readTokenLedger(statePath) {
    let raw;
    try {
        raw = await readFile(tokenLedgerPath(statePath), 'utf8');
    }
    catch {
        return [];
    }
    const sessions = new Map();
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        }
        catch {
            continue; // tolerate a truncated trailing line
        }
        const parsed = parseRecord(record);
        if (!parsed)
            continue;
        const key = `${parsed.agentId} ${parsed.cliSessionId}`;
        const existing = sessions.get(key);
        const session = existing ?? {
            agentId: parsed.agentId,
            cli: parsed.cli,
            cliSessionId: parsed.cliSessionId,
        };
        if (parsed.kind === 'session') {
            if (parsed.role)
                session.role = parsed.role;
            if (parsed.cli)
                session.cli = parsed.cli;
        }
        else {
            session.lastSample = {
                measured: parsed.measured,
                perModel: parsed.perModel,
                sampledAt: parsed.sampledAt,
            };
            if (parsed.cli && !existing)
                session.cli = parsed.cli;
        }
        sessions.set(key, session);
    }
    return [...sessions.values()];
}
function parseRecord(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    const agentId = typeof record.agentId === 'string' ? record.agentId : '';
    const cliSessionId = typeof record.cliSessionId === 'string' ? record.cliSessionId : '';
    const cli = typeof record.cli === 'string' ? record.cli : '';
    if (!agentId || !cliSessionId)
        return null;
    if (record.kind === 'session') {
        return {
            kind: 'session',
            agentId,
            cli,
            cliSessionId,
            role: typeof record.role === 'string' && record.role ? record.role : undefined,
            at: typeof record.at === 'string' ? record.at : '',
        };
    }
    if (record.kind === 'sample') {
        return {
            kind: 'sample',
            agentId,
            cli,
            cliSessionId,
            measured: record.measured === true,
            // Split rows have their total RE-derived from the components rather than
            // trusted as written: samples appended before cache reads left the total
            // carry the old inflated figure, and re-deriving on read fixes every run
            // already on disk without rewriting an append-only file.
            perModel: Array.isArray(record.perModel)
                ? withDerivedTotals(record.perModel.filter(isModelUsageRow))
                : [],
            sampledAt: typeof record.sampledAt === 'string' ? record.sampledAt : '',
            reason: record.reason === 'session-end' ? 'session-end' : 'teardown',
        };
    }
    return null;
}
function isModelUsageRow(value) {
    if (!value || typeof value !== 'object')
        return false;
    const row = value;
    return (typeof row.model === 'string'
        && typeof row.input === 'number'
        && typeof row.output === 'number'
        && typeof row.cacheRead === 'number'
        && typeof row.cacheCreation === 'number'
        && typeof row.total === 'number'
        && typeof row.split === 'boolean');
}
