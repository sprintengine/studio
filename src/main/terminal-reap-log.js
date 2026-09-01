// Bounded, in-memory audit trail of terminals the reaper acted on this session.
// The diagnostics panel polls it (via the process-metrics snapshot) to show
// "what was reaped, and from which workspace". Deliberately ephemeral: it is a
// debugging aid, not durable state, so it lives only for the app process and is
// capped to avoid unbounded growth on long sessions.
export const MAX_REAP_EVENTS = 200;
const reapEvents = [];
export function recordReapEvent(event) {
    reapEvents.push(event);
    if (reapEvents.length > MAX_REAP_EVENTS) {
        reapEvents.splice(0, reapEvents.length - MAX_REAP_EVENTS);
    }
}
// Most-recent-first, so the panel shows the latest reap at the top. Returns a
// copy so callers cannot mutate the buffer.
export function listRecentReapEvents() {
    return [...reapEvents].reverse();
}
// Test-only: reset the buffer between cases.
export function clearReapEvents() {
    reapEvents.length = 0;
}
