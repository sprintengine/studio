import type { WebContents } from 'electron';
import type { TerminalSession } from './terminal-session';
type TerminalOutputCause = 'timer' | 'exit' | 'dispose' | 'visibility';
/**
 * One attached viewer of a session's output.
 *
 * This buffer used to hold exactly ONE pending batch per session, forwarded to
 * the renderer behind a single per-session gate (`session.visible`). A remote
 * attach (MC-2165) is a second, independent viewer of the same pty: it must
 * keep streaming while the local pane is hidden, and a slow remote consumer
 * must not stall the local one. So the batch, the gate, and the byte bound are
 * all per SINK now, and the renderer is simply the sink the runtime always has.
 *
 * `shouldForward` is the per-sink flush gate. For the renderer it is the
 * session's visibility (a hidden xterm is frozen, so forwarding to it would be
 * dropped bytes the reveal replay has to resend anyway). For a remote viewer it
 * is its own socket — deliberately NOT the local pane's visibility.
 */
export type TerminalOutputSink = {
    /** Unique within a session. The renderer's is `TERMINAL_RENDERER_SINK_ID`. */
    id: string;
    shouldForward(session: TerminalSession | undefined): boolean;
    forward(data: string): void;
    /** Bound on bytes buffered but not yet forwarded, per sink. */
    pendingLimitBytes: number;
    /** Text put in place of the bytes dropped at the bound; omit for a sink that resyncs instead. */
    droppedNotice?: string;
    /** Called when the bound was hit and older bytes were dropped. */
    onDropped?(): void;
};
export declare const TERMINAL_RENDERER_SINK_ID = "renderer";
type TerminalOutputBufferOptions = {
    getSession(sessionId: string): TerminalSession | undefined;
    sendTerminalEvent(sender: WebContents, channel: string, payload: string | number): void;
    recordDataBatch(session: TerminalSession | undefined, cause: TerminalOutputCause, chunkCount: number, byteCount: number): void;
    /** Viewers attached beyond the renderer; empty for every session nobody remote is watching. */
    resolveExtraSinks?(sessionId: string): TerminalOutputSink[];
};
export declare const TERMINAL_PENDING_DATA_LIMIT: number;
export declare function createTerminalOutputBuffer({ getSession, sendTerminalEvent, recordDataBatch, resolveExtraSinks, }: TerminalOutputBufferOptions): {
    flush: (sessionId: string, cause?: TerminalOutputCause) => void;
    send: (session: TerminalSession, data: string) => void;
    discard: (sessionId: string, sinkId: string) => void;
};
export {};
