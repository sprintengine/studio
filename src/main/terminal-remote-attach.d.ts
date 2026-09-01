import type { TerminalSessionSnapshot } from '../shared/electron-api';
/**
 * What an attached viewer may do.
 *
 * `observe` is stream-only: input and resize are refused at the frame, never
 * quietly ignored. `control` is arbitrary shell on the host, which is why the
 * pairing scopes keep it a separate grant (see src/shared/tailnet.ts).
 */
export type TerminalAttachScope = 'observe' | 'control';
export type TerminalAttachFrame = 
/**
 * The retained scrollback. `attach` is the join-mid-session snapshot (the
 * same replay-then-live path a hidden pane's reveal uses); `resync` is the
 * recovery after this viewer fell too far behind and its queued bytes were
 * dropped — the replay is a superset of what was dropped, so it repaints
 * rather than leaving a hole.
 */
{
    type: 'replay';
    data: string;
    reason: 'attach' | 'resync';
} | {
    type: 'output';
    data: string;
}
/** The pty exited on its own. The session stays, painted, until it is closed. */
 | {
    type: 'exit';
    exitCode: number;
}
/** The session went away (closed, or paused to reclaim memory). Nothing more will arrive. */
 | {
    type: 'ended';
    reason: string;
};
export type TerminalAttachTransport = {
    /** Unique per attached socket; the runtime keys this viewer's buffer by it. */
    viewerId: string;
    send(frame: TerminalAttachFrame): void;
    isOpen(): boolean;
    /** Bytes accepted by the transport but not yet on the wire — the backpressure probe. */
    queuedBytes(): number;
};
export type TerminalRemoteOutcome = {
    ok: true;
} | {
    ok: false;
    code: string;
    message: string;
};
export type TerminalAttachment = {
    sessionId: string;
    scope: TerminalAttachScope;
    /** The session as it was at attach, so a client can label the stream immediately. */
    session: TerminalSessionSnapshot;
    write(data: string): TerminalRemoteOutcome;
    resize(cols: number, rows: number): TerminalRemoteOutcome;
    detach(): void;
};
export type TerminalAttachResult = {
    ok: true;
    attachment: TerminalAttachment;
} | {
    ok: false;
    code: string;
    message: string;
};
export type TerminalRemoteHost = {
    listSessions(): TerminalSessionSnapshot[];
    attach(input: {
        sessionId: string;
        scope: TerminalAttachScope;
        transport: TerminalAttachTransport;
    }): TerminalAttachResult;
};
/**
 * How far a remote viewer's transport may fall behind before its output is
 * dropped in favour of a later replay.
 *
 * The pty never waits on a socket: a consumer on a slow link that cannot drain
 * loses bytes and is repainted from the retained scrollback, because the
 * alternative — queueing without bound — grows main's heap until the app dies,
 * and the alternative to THAT — waiting — stalls the pty and the local window
 * behind a stranger's link.
 */
export declare const TERMINAL_REMOTE_TRANSPORT_HIGH_WATER_BYTES: number;
/** Bytes buffered for one remote viewer before the oldest are dropped and it resyncs. */
export declare const TERMINAL_REMOTE_PENDING_LIMIT_BYTES: number;
