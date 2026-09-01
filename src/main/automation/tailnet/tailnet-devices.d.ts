import { type TailnetDevice, type TailnetPairingState, type TailnetScope } from '../../../shared/tailnet';
export declare const TAILNET_DEVICES_FILENAME = "tailnet-remote-devices.json";
/**
 * Long enough that a code minted once stays usable across a working month, so
 * pairing a new machine is never a race against a countdown.
 *
 * The ceiling is not really this number: the offer is in-memory only (see the
 * note above), so an app restart invalidates it well before 30 days on any
 * machine that is not left running. What the long TTL buys is that the code
 * lives as long as the app does, rather than lapsing under a still-open window.
 * Anything minting a code — Settings, or `tailnet.offer_pairing` on the gateway
 * — says so, because "30 days" and "until this app restarts" are not the same
 * promise and only one of them is kept.
 *
 * A longer window is not a longer guessing window: the token is 24 random bytes
 * (192 bits), so it is unguessable at any TTL. What it does widen is how long an
 * unredeemed offer lingers — hence "works once", the Settings cancel action, and
 * the fact that a wrong guess never burns the outstanding offer.
 */
export declare const DEFAULT_PAIRING_TTL_MS: number;
export type { TailnetDevice, TailnetPairingState };
export type TailnetPairingOffer = {
    /** The one-time token. Returned once at mint; never stored, never re-readable. */
    token: string;
    scopes: TailnetScope[];
    expiresAt: string;
};
export type TailnetPairingResult = {
    ok: true;
    device: TailnetDevice;
    deviceToken: string;
} | {
    ok: false;
    code: 'pairing_not_offered' | 'pairing_expired' | 'pairing_invalid' | 'invalid_device_name';
    message: string;
};
export type TailnetDeviceStore = {
    listDevices(): TailnetDevice[];
    /** Replace any outstanding pairing with a fresh one (the Settings "regenerate" action). */
    offerPairing(input: {
        scopes: TailnetScope[];
        ttlMs?: number;
    }): TailnetPairingOffer;
    getPairingState(): TailnetPairingState | null;
    cancelPairing(): void;
    redeemPairing(input: {
        token: unknown;
        deviceName: unknown;
    }): TailnetPairingResult;
    /** The device this bearer token belongs to, or null. Reads live state, so a revoke lands on the next call. */
    authenticate(bearerToken: string | null | undefined): TailnetDevice | null;
    revokeDevice(deviceId: string): boolean;
    /** Fires with the revoked device id so live streams for it can be closed. */
    onDeviceRevoked(listener: (deviceId: string) => void): () => void;
    recordSeen(deviceId: string, peerNode: string | null): void;
};
export declare function createTailnetDeviceStore(options: {
    resolveUserDataDir: () => string;
    now?: () => Date;
    log?: (message: string) => void;
}): TailnetDeviceStore;
