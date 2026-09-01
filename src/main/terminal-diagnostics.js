const TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS = 1_000;
const TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS = 1_000;
const TERMINAL_SLOW_INPUT_WRITE_MS = 50;
export function createTerminalDiagnostics({ enabled, logMainPerfEvent }) {
    const terminalBatchDiagnostics = new Map();
    const terminalInputDiagnostics = new Map();
    function recordDataBatch(session, cause, chunkCount, byteCount) {
        if (!session || !enabled || chunkCount === 0)
            return;
        const now = Date.now();
        const stats = terminalBatchDiagnostics.get(session.sessionId) ?? {
            batches: 0,
            chunks: 0,
            bytes: 0,
            lastLogAt: now,
        };
        stats.batches += 1;
        stats.chunks += chunkCount;
        stats.bytes += byteCount;
        if (cause !== 'timer' || now - stats.lastLogAt >= TERMINAL_BATCH_DIAGNOSTIC_INTERVAL_MS) {
            logMainPerfEvent('Terminal', 'output-batches', {
                sessionId: session.sessionId,
                kind: session.kind,
                workspaceId: session.workspaceId,
                cause,
                batches: stats.batches,
                chunks: stats.chunks,
                bytes: stats.bytes,
                retainedOutputBytes: session.outputBytes,
            });
            stats.batches = 0;
            stats.chunks = 0;
            stats.bytes = 0;
            stats.lastLogAt = now;
        }
        terminalBatchDiagnostics.set(session.sessionId, stats);
    }
    function recordInputWrite(session, byteCount, elapsedMs, ok) {
        if (!session || !enabled)
            return;
        const now = Date.now();
        const stats = terminalInputDiagnostics.get(session.sessionId) ?? {
            writes: 0,
            bytes: 0,
            totalMs: 0,
            maxMs: 0,
            errors: 0,
            lastLogAt: now,
        };
        stats.writes += 1;
        stats.bytes += byteCount;
        stats.totalMs += elapsedMs;
        stats.maxMs = Math.max(stats.maxMs, elapsedMs);
        if (!ok)
            stats.errors += 1;
        if (now - stats.lastLogAt >= TERMINAL_INPUT_DIAGNOSTIC_INTERVAL_MS || elapsedMs >= TERMINAL_SLOW_INPUT_WRITE_MS || !ok) {
            logMainPerfEvent('Terminal', 'input-writes', {
                sessionId: session.sessionId,
                kind: session.kind,
                workspaceId: session.workspaceId,
                agentId: session.agentId,
                terminalId: session.terminalId,
                writes: stats.writes,
                bytes: stats.bytes,
                avgMs: stats.writes > 0 ? Math.round((stats.totalMs / stats.writes) * 10) / 10 : 0,
                maxMs: Math.round(stats.maxMs * 10) / 10,
                errors: stats.errors,
            });
            stats.writes = 0;
            stats.bytes = 0;
            stats.totalMs = 0;
            stats.maxMs = 0;
            stats.errors = 0;
            stats.lastLogAt = now;
        }
        terminalInputDiagnostics.set(session.sessionId, stats);
    }
    function recordActivityTransition(session, previousActivity, nextActivity) {
        if (!session || !enabled)
            return;
        logMainPerfEvent('Terminal', 'activity-transition', {
            sessionId: session.sessionId,
            kind: session.kind,
            workspaceId: session.workspaceId,
            agentId: session.agentId,
            terminalId: session.terminalId,
            previousKind: previousActivity.kind,
            nextKind: nextActivity.kind,
            lastOutputAt: session.lastOutputAt,
            lastInputAt: session.lastInputAt,
            exitCode: 'exitCode' in nextActivity ? nextActivity.exitCode : undefined,
            message: nextActivity.kind === 'failed' ? nextActivity.message : undefined,
        });
    }
    function clear(sessionId) {
        terminalBatchDiagnostics.delete(sessionId);
        terminalInputDiagnostics.delete(sessionId);
    }
    return {
        recordDataBatch,
        recordInputWrite,
        recordActivityTransition,
        clear,
    };
}
