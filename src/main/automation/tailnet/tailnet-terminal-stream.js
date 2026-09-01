import { tailnetScopeGrantsAccess } from '../../../shared/tailnet';
import { createWebSocketFrameDecoder, encodeCloseFrame, encodePongFrame, encodeTextFrame, MAX_WEBSOCKET_MESSAGE_BYTES, WEBSOCKET_CLOSE_GOING_AWAY, WEBSOCKET_CLOSE_NORMAL, } from './websocket-frames';
/**
 * The attach scope a device's grants allow, or null when it may not attach.
 *
 * Control is a superset of observe here for the same reason `operate` implies
 * `read`: a device trusted to type into a terminal is necessarily trusted to
 * see it, and the reverse never holds.
 */
export function terminalAttachScopeFor(scopes) {
    const granted = new Set(scopes);
    if (granted.has('terminal:control'))
        return 'control';
    return tailnetScopeGrantsAccess(granted, 'terminal:observe') ? 'observe' : null;
}
/**
 * Drive one already-upgraded terminal socket.
 *
 * The caller has authenticated the ticket and written the 101; from here this
 * owns the framing, the attachment, and the socket's lifetime.
 */
export function createTailnetTerminalStream(options) {
    const { socket } = options;
    let closed = false;
    let attachment = null;
    const send = (payload) => {
        if (closed || socket.destroyed)
            return;
        socket.write(encodeTextFrame(JSON.stringify(payload)));
    };
    const close = (code, reason) => {
        if (closed)
            return;
        closed = true;
        attachment?.detach();
        attachment = null;
        if (!socket.destroyed) {
            try {
                socket.write(encodeCloseFrame(code, reason));
            }
            catch {
                // The peer is already gone; ending below is the whole cleanup.
            }
            socket.end();
        }
        options.onClosed();
    };
    const scope = terminalAttachScopeFor(options.scopes);
    if (!scope) {
        // Reached only if the caller upgraded a device without a terminal grant;
        // refuse in the stream too rather than trusting one gate.
        send({
            type: 'error',
            code: 'terminal_scope_required',
            message: 'This device is not granted terminal access. Re-pair it with the terminal watch or control scope.',
        });
        close(WEBSOCKET_CLOSE_NORMAL, 'terminal_scope_required');
        return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed };
    }
    const attached = options.terminals.attach({
        sessionId: options.sessionId,
        scope,
        transport: {
            viewerId: `tailnet:${options.deviceId}:${options.sessionId}:${nextViewerSequence()}`,
            send: (frame) => send({ ...frame }),
            isOpen: () => !closed && !socket.destroyed,
            // Node buffers unwritten bytes in memory; this is how far behind the peer
            // is, and the runtime drops-and-resyncs rather than growing it.
            queuedBytes: () => socket.writableLength,
        },
    });
    if (!attached.ok) {
        send({ type: 'error', code: attached.code, message: attached.message });
        close(WEBSOCKET_CLOSE_NORMAL, attached.code);
        return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed };
    }
    attachment = attached.attachment;
    // Sent AFTER the attach replay so the client's first frame is always the
    // scrollback: a header arriving first would tempt a client to paint an empty
    // screen and then be repainted.
    send({
        type: 'attached',
        sessionId: attachment.sessionId,
        scope: attachment.scope,
        session: attachment.session,
    });
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES);
    const handleText = (text) => {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            send({ type: 'error', code: 'invalid_json', message: 'Terminal frames must be JSON objects.' });
            return;
        }
        const frame = asClientFrame(parsed);
        if (!frame) {
            send({
                type: 'error',
                code: 'unknown_frame',
                message: 'This channel accepts {"type":"input","data":"…"} and {"type":"resize","cols":N,"rows":N}.',
            });
            return;
        }
        if (!attachment)
            return;
        // Frame-level scope enforcement. An observe-scoped socket sending input is
        // refused HERE, before the runtime is asked, and the violation is logged:
        // it is a security event, not a client mistake to swallow.
        if (scope !== 'control') {
            options.log?.(`tailnet terminal: device ${options.deviceName} (${options.deviceId}) sent "${frame.type}" on a watch-only attach to ${options.sessionId}; dropped.`);
            send({
                type: 'error',
                code: 'terminal_control_required',
                message: 'This connection is attached to watch only. Re-pair the device with the terminal control scope to type into it.',
            });
            return;
        }
        const outcome = frame.type === 'input'
            ? attachment.write(frame.data)
            : attachment.resize(frame.cols, frame.rows);
        if (!outcome.ok)
            send({ type: 'error', code: outcome.code, message: outcome.message });
    };
    const consume = (chunk) => {
        const decoded = decoder.push(chunk);
        if (decoded.kind === 'error') {
            close(decoded.code, decoded.reason);
            return;
        }
        for (const frame of decoded.frames) {
            if (frame.kind === 'close') {
                close(WEBSOCKET_CLOSE_GOING_AWAY, '');
                return;
            }
            if (frame.kind === 'ping') {
                if (!closed && !socket.destroyed)
                    socket.write(encodePongFrame(frame.payload));
                continue;
            }
            if (frame.kind !== 'text')
                continue;
            handleText(frame.text);
        }
    };
    const forget = () => {
        if (closed)
            return;
        closed = true;
        attachment?.detach();
        attachment = null;
        options.onClosed();
    };
    socket.on('data', (chunk) => consume(chunk));
    // An upgraded socket is half-open: when the peer disconnects, Node emits
    // `end` and NOT `close` (the write side is still ours). Listening only for
    // `close` would leave the viewer attached to a pty nobody is reading, which
    // is precisely the leak a long-lived stream cannot afford.
    socket.on('end', () => {
        forget();
        socket.destroy();
    });
    socket.on('close', forget);
    socket.on('error', () => {
        attachment?.detach();
        attachment = null;
        if (!closed) {
            closed = true;
            options.onClosed();
        }
        socket.destroy();
    });
    return { deviceId: options.deviceId, sessionId: options.sessionId, close, isClosed: () => closed };
}
// Viewer ids must be unique per socket, including two attaches from the same
// device to the same session (the item's "a second concurrent viewer" case).
let viewerSequence = 0;
function nextViewerSequence() {
    viewerSequence += 1;
    return viewerSequence;
}
function asClientFrame(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    if (record.type === 'input' && typeof record.data === 'string') {
        return { type: 'input', data: record.data };
    }
    if (record.type === 'resize' && isPositiveInteger(record.cols) && isPositiveInteger(record.rows)) {
        return { type: 'resize', cols: record.cols, rows: record.rows };
    }
    return null;
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
