const DIAGNOSTIC_SLOW_IPC_MS = 250;
export function createMainDiagnostics({ enabled }) {
    function logMainPerfEvent(scope, event, payload) {
        if (!enabled)
            return;
        console.info(`[${scope}] ${event}`, payload);
    }
    async function withIpcDiagnostics(scope, event, payload, action) {
        const startedAt = Date.now();
        try {
            const result = await action();
            const elapsedMs = Date.now() - startedAt;
            if (enabled || elapsedMs >= DIAGNOSTIC_SLOW_IPC_MS) {
                logMainPerfEvent(scope, event, {
                    ...payload,
                    elapsedMs,
                    ok: true,
                });
            }
            return result;
        }
        catch (error) {
            logMainPerfEvent(scope, `${event}-error`, {
                ...payload,
                elapsedMs: Date.now() - startedAt,
                ok: false,
                message: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    return {
        logMainPerfEvent,
        withIpcDiagnostics,
    };
}
