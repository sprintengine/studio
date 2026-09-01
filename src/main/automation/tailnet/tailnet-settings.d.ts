export declare const TAILNET_SETTINGS_FILENAME = "tailnet-remote-settings.json";
/**
 * Fixed default so peer discovery can probe a known port (MC-2163) instead of
 * scanning. Configurable because a machine may already be using it.
 */
export declare const DEFAULT_TAILNET_LISTENER_PORT = 8471;
export type TailnetSettings = {
    enabled: boolean;
    port: number;
};
export type TailnetSettingsReadResult = {
    settings: TailnetSettings;
    /** Set when the file existed but could not be read or parsed; the listener stays off. */
    error: string | null;
};
export declare function readTailnetSettings(userDataDir: string): TailnetSettingsReadResult;
export declare function writeTailnetSettings(userDataDir: string, settings: TailnetSettings): void;
/** Port 0 is excluded: an ephemeral port cannot be discovered or written down. */
export declare function isUsablePort(value: unknown): value is number;
