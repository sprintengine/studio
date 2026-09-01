import type { Duplex } from 'stream';
import type { TerminalAttachScope, TerminalRemoteHost } from '../../terminal-remote-attach';
import { type TailnetScope } from '../../../shared/tailnet';
export type TailnetTerminalStream = {
    deviceId: string;
    sessionId: string;
    /** Close the socket, telling the client why. */
    close(code: number, reason: string): void;
    /** True once the underlying socket is gone. */
    isClosed(): boolean;
};
export type TailnetTerminalStreamOptions = {
    socket: Duplex;
    sessionId: string;
    deviceId: string;
    deviceName: string;
    scopes: readonly TailnetScope[];
    terminals: TerminalRemoteHost;
    /** Called once when the socket is finished, so the server can forget it. */
    onClosed: () => void;
    log?: (message: string) => void;
};
/**
 * The attach scope a device's grants allow, or null when it may not attach.
 *
 * Control is a superset of observe here for the same reason `operate` implies
 * `read`: a device trusted to type into a terminal is necessarily trusted to
 * see it, and the reverse never holds.
 */
export declare function terminalAttachScopeFor(scopes: readonly TailnetScope[]): TerminalAttachScope | null;
/**
 * Drive one already-upgraded terminal socket.
 *
 * The caller has authenticated the ticket and written the 101; from here this
 * owns the framing, the attachment, and the socket's lifetime.
 */
export declare function createTailnetTerminalStream(options: TailnetTerminalStreamOptions): TailnetTerminalStream;
