import { type TailnetScope } from '../../../shared/tailnet';
export type TailnetEndpoint = {
    host: string;
    port: number;
};
export type RemoteCallOutcome<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    code: string;
    message: string;
};
/**
 * Split `host:port` — including the `[v6]:port` form the listener publishes.
 *
 * Returns null rather than guessing a port: an endpoint we cannot read is one we
 * must not dial, because the guess would be a request to somewhere nobody chose.
 */
export declare function parseTailnetEndpoint(value: string): TailnetEndpoint | null;
export declare function formatTailnetEndpoint(endpoint: TailnetEndpoint): string;
/** A `multicode-tailnet://pair?…` link, as the other machine's Settings shows it. */
export declare function parsePairingUrl(value: string): {
    endpoint: TailnetEndpoint;
    pairingToken: string;
} | null;
type JsonAnswer = {
    status: number;
    body: unknown;
};
/** One HTTP round trip to a listener. Never throws for a status; a status is an answer. */
export declare function requestTailnetJson(input: {
    endpoint: TailnetEndpoint;
    method: 'GET' | 'POST';
    path: string;
    token?: string;
    body?: unknown;
    timeoutMs?: number;
}): Promise<JsonAnswer>;
/** Redeem a one-time pairing code for a device token this machine can keep. */
export declare function pairWithMachine(input: {
    endpoint: TailnetEndpoint;
    pairingToken: string;
    deviceName: string;
}): Promise<RemoteCallOutcome<{
    deviceId: string;
    deviceName: string;
    deviceToken: string;
    scopes: TailnetScope[];
}>>;
/** What the remote says our device is and may do, right now. */
export declare function readRemoteIdentity(input: {
    endpoint: TailnetEndpoint;
    token: string;
}): Promise<RemoteCallOutcome<{
    deviceId: string;
    deviceName: string;
    scopes: TailnetScope[];
}>>;
/**
 * Call one gateway tool on the remote machine.
 *
 * Over the stateless POST endpoint rather than the WebSocket: these are
 * one-shot reads for a panel, they carry no connection-scoped declaration, and
 * holding a socket open per browse would be a socket per machine for a list
 * somebody glanced at.
 *
 * A tool that refuses (out of scope, unknown workspace) comes back as
 * `{ok:false}` with the tool's own code — never as an empty success.
 */
export declare function callRemoteTool(input: {
    endpoint: TailnetEndpoint;
    token: string;
    tool: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
}): Promise<RemoteCallOutcome<Record<string, unknown>>>;
export type RemoteTerminalSocket = {
    /** Send one client frame (`input` or `resize`). No-op once closed. */
    send(frame: Record<string, unknown>): void;
    /** Close from this end, telling the peer why. */
    close(reason: string): void;
    isOpen(): boolean;
};
export type RemoteTerminalSocketHandlers = {
    /** One decoded server frame: replay, output, attached, exit, ended, error. */
    onFrame(frame: Record<string, unknown>): void;
    /**
     * The socket is finished. `code` is the peer's WebSocket close code where it
     * sent one (4401 means the device was revoked mid-stream), and `reason` is a
     * sentence for a person.
     */
    onClosed(outcome: {
        code: number | null;
        reason: string;
    }): void;
};
/**
 * Attach to one remote terminal session over its own WebSocket.
 *
 * Its own socket per attachment, mirroring the server side: a terminal printing
 * a build log is the chattiest thing this transport carries, and sharing would
 * put a browse behind it.
 */
export declare function openRemoteTerminalSocket(input: {
    endpoint: TailnetEndpoint;
    token: string;
    sessionId: string;
    handlers: RemoteTerminalSocketHandlers;
}): Promise<RemoteCallOutcome<RemoteTerminalSocket>>;
export {};
