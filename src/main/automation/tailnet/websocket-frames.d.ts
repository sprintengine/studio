export declare const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Close codes this server sends (RFC 6455 §7.4.1 plus the 4xxx private range). */
export declare const WEBSOCKET_CLOSE_NORMAL = 1000;
export declare const WEBSOCKET_CLOSE_GOING_AWAY = 1001;
export declare const WEBSOCKET_CLOSE_PROTOCOL_ERROR = 1002;
export declare const WEBSOCKET_CLOSE_UNSUPPORTED_DATA = 1003;
export declare const WEBSOCKET_CLOSE_MESSAGE_TOO_BIG = 1009;
/** Private-range code for a device whose access was revoked mid-stream. */
export declare const WEBSOCKET_CLOSE_REVOKED = 4401;
/** One message may not exceed this; matches the socket transport's 1 MiB line cap. */
export declare const MAX_WEBSOCKET_MESSAGE_BYTES: number;
export declare function computeWebSocketAcceptKey(clientKey: string): string;
export type WebSocketFrame = {
    kind: 'text';
    text: string;
} | {
    kind: 'ping';
    payload: Buffer;
} | {
    kind: 'pong';
}
/** Code/reason are carried for a client that must report WHY the peer hung up (4401 revoked, say). */
 | {
    kind: 'close';
    code: number;
    reason: string;
};
export type WebSocketDecodeResult = {
    kind: 'frames';
    frames: WebSocketFrame[];
} | {
    kind: 'error';
    code: number;
    reason: string;
};
export type WebSocketFrameDecoder = {
    /** Feed received bytes; returns whole frames, or the failure that must close the socket. */
    push(chunk: Buffer): WebSocketDecodeResult;
};
/**
 * Which side of the connection is decoding.
 *
 * `server` requires every incoming frame to be masked, because the spec
 * requires a client to mask and an unmasked client frame is a violation the
 * server must fail on. `client` decodes frames from the listener, which are
 * never masked — but honours the mask bit anyway, because reading the bit is
 * what decoding a frame means, not an optimism about who sent it.
 */
export type WebSocketDecoderRole = 'server' | 'client';
export declare function createWebSocketFrameDecoder(maxMessageBytes?: number, role?: WebSocketDecoderRole): WebSocketFrameDecoder;
export declare function encodeTextFrame(text: string): Buffer;
export declare function encodePongFrame(payload: Buffer): Buffer;
export declare function encodeCloseFrame(code: number, reason?: string): Buffer;
/** A text frame from the CLIENT half, masked as the spec requires. */
export declare function encodeMaskedTextFrame(text: string): Buffer;
export declare function encodeMaskedCloseFrame(code: number, reason?: string): Buffer;
export declare function encodeMaskedPongFrame(payload: Buffer): Buffer;
