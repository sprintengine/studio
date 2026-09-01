export const TERMINAL_RENDERER_SINK_ID = 'renderer';
const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0;
const TERMINAL_DATA_BATCH_MS = 16;
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250;
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096;
export const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024;
const TERMINAL_THROTTLE_NOTICE = '\r\n[Terminal output throttled to keep the UI responsive]\r\n';
export function createTerminalOutputBuffer({ getSession, sendTerminalEvent, recordDataBatch, resolveExtraSinks, }) {
    // sessionId -> sinkId -> the batch waiting for that one viewer.
    const pendingTerminalData = new Map();
    function flush(sessionId, cause = 'timer') {
        const bySink = pendingTerminalData.get(sessionId);
        if (!bySink)
            return;
        pendingTerminalData.delete(sessionId);
        const session = getSession(sessionId);
        for (const pending of bySink.values()) {
            clearTimeout(pending.timer);
            const data = pending.chunks.join('');
            if (pending.sink.shouldForward(session)) {
                pending.sink.forward(data);
            }
            // Diagnostics describe the UI's data path, so they stay the renderer's:
            // counting a remote viewer's batches too would silently double the
            // throughput the Diagnostics panel reports.
            if (pending.sink.id === TERMINAL_RENDERER_SINK_ID) {
                recordDataBatch(session, cause, pending.chunks.length, Buffer.byteLength(data));
            }
        }
    }
    /** Drop one viewer's queued batch — used when it detaches mid-flight. */
    function discard(sessionId, sinkId) {
        const bySink = pendingTerminalData.get(sessionId);
        const pending = bySink?.get(sinkId);
        if (!bySink || !pending)
            return;
        clearTimeout(pending.timer);
        bySink.delete(sinkId);
        if (bySink.size === 0)
            pendingTerminalData.delete(sessionId);
    }
    function send(session, data) {
        const sinks = [rendererSink(session), ...(resolveExtraSinks?.(session.sessionId) ?? [])];
        for (const sink of sinks)
            queue(session, sink, data);
    }
    function queue(session, sink, data) {
        const bySink = pendingTerminalData.get(session.sessionId) ?? new Map();
        pendingTerminalData.set(session.sessionId, bySink);
        const pending = bySink.get(sink.id);
        if (pending) {
            // Re-bind the sink: the renderer's is rebuilt per send so it always
            // forwards to the session's CURRENT WebContents (a reveal can adopt a new
            // window between the first chunk of a batch and its flush).
            pending.sink = sink;
            pending.chunks.push(data);
            pending.bytes += Buffer.byteLength(data);
            if (pending.bytes > sink.pendingLimitBytes) {
                const trimmed = trimPendingTerminalChunks(pending.chunks, sink.pendingLimitBytes, sink.droppedNotice);
                pending.chunks = trimmed.chunks;
                pending.bytes = trimmed.bytes;
                if (trimmed.dropped)
                    sink.onDropped?.();
            }
            return;
        }
        const delayMs = getTerminalDataBatchDelay(session, data);
        const timer = setTimeout(() => {
            flush(session.sessionId, 'timer');
        }, delayMs);
        bySink.set(sink.id, {
            sink,
            chunks: [data],
            bytes: Buffer.byteLength(data),
            timer,
        });
    }
    function rendererSink(session) {
        const channel = `terminal:data:${session.sessionId}`;
        const sender = session.sender;
        return {
            id: TERMINAL_RENDERER_SINK_ID,
            // Unchanged from before the multi-sink split: while a pane is hidden the
            // bytes are held in the retained replay buffer and the reveal path
            // resends them, so forwarding here would only duplicate the tail.
            shouldForward: (current) => current?.visible !== false,
            forward: (data) => sendTerminalEvent(sender, channel, data),
            pendingLimitBytes: TERMINAL_PENDING_DATA_LIMIT,
            droppedNotice: TERMINAL_THROTTLE_NOTICE,
        };
    }
    return {
        flush,
        send,
        discard,
    };
}
function trimPendingTerminalChunks(chunks, maxBytes, notice) {
    let bytes = 0;
    const retained = [];
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const chunk = chunks[index] ?? '';
        const chunkBytes = Buffer.byteLength(chunk);
        if (bytes + chunkBytes <= maxBytes) {
            retained.unshift(chunk);
            bytes += chunkBytes;
            continue;
        }
        const remainingBytes = maxBytes - bytes;
        if (remainingBytes > 0) {
            const tail = Buffer.from(chunk)
                .subarray(Math.max(0, chunkBytes - remainingBytes))
                .toString('utf8');
            retained.unshift(tail);
            bytes += Buffer.byteLength(tail);
        }
        if (notice)
            retained.unshift(notice);
        return {
            chunks: retained,
            bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0),
            dropped: true,
        };
    }
    return { chunks: retained, bytes, dropped: false };
}
function getTerminalDataBatchDelay(session, data) {
    const recentInput = session.lastInputAt !== null
        && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS;
    const smallOutput = Buffer.byteLength(data) <= TERMINAL_INTERACTIVE_DATA_LIMIT;
    return recentInput && smallOutput
        ? TERMINAL_INTERACTIVE_DATA_BATCH_MS
        : TERMINAL_DATA_BATCH_MS;
}
