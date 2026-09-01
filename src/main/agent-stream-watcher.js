// Pure logic for watching an agent's pty output stream to drive the two
// plugin-driven lifecycle hooks introduced in BYO-CLI Phase 3:
//
//   - send-after-ready injection: wait for a readiness pattern in the output
//     stream, then write the user prompt to stdin. This lets the autonomous
//     runner stop using `claude --print` (which bills as full-rate API
//     usage) and instead drive an interactive subscription-billed session.
//
//   - output-sentinel completion: watch the output stream for a sentinel
//     literal the agent is taught to emit at the end of its turn, and tear
//     the session down without waiting for the process to exit.
//
// This watcher is plugin-descriptor driven (Switchboard agent plugins choose
// their own sentinel literal). It is NOT used by Sprint Engine wake-up:
// Sprint Engine wakeups consume `currentDispatch` from the canonical
// projection (see buildSprintEngineDispatchPrompt) and never depend on
// stdout sentinels.
//
// No I/O, no pty, no electron — just the pure stream-matching state machine
// so the runtime wiring stays thin and the tricky bits stay unit-testable.
const DEFAULT_ROLLING_BUFFER_SIZE = 8192;
export function createAgentStreamWatcher(input) {
    const bufferSize = Math.max(64, input.rollingBufferSize ?? DEFAULT_ROLLING_BUFFER_SIZE);
    let buffer = '';
    let readyAlreadyMatched = false;
    let completionAlreadyMatched = false;
    function ingest(chunk) {
        if (chunk.length === 0) {
            return { readyMatched: false, completionMatched: false };
        }
        buffer = buffer.length + chunk.length > bufferSize
            ? buffer.slice(-(bufferSize - chunk.length)) + chunk
            : buffer + chunk;
        const result = {
            readyMatched: false,
            completionMatched: false,
        };
        if (!readyAlreadyMatched && input.readinessPattern && input.readinessPattern.test(buffer)) {
            readyAlreadyMatched = true;
            result.readyMatched = true;
        }
        if (!completionAlreadyMatched &&
            input.completionSentinel &&
            buffer.includes(input.completionSentinel)) {
            completionAlreadyMatched = true;
            result.completionMatched = true;
        }
        return result;
    }
    function reset() {
        buffer = '';
        readyAlreadyMatched = false;
        completionAlreadyMatched = false;
    }
    return { ingest, reset };
}
