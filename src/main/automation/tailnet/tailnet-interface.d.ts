import { type NetworkInterfaceInfo } from 'os';
/** Tailscale's IPv4 pool: 100.64.0.0/10, i.e. 100.64.x.x – 100.127.x.x. */
export declare const TAILNET_IPV4_RANGE = "100.64.0.0/10";
/** Tailscale's IPv6 pool. */
export declare const TAILNET_IPV6_PREFIX = "fd7a:115c:a1e0:";
export type TailnetInterface = {
    address: string;
    family: 'IPv4' | 'IPv6';
    /** OS interface name (`utun4`, `tailscale0`), for diagnostics only. */
    interfaceName: string;
};
export declare function isTailnetAddress(address: string): boolean;
export declare function isLoopbackAddress(address: string): boolean;
/**
 * The bind allowlist: a tailnet address, or loopback.
 *
 * Loopback is included so tests (and a developer poking at the listener from
 * the same machine) exercise the real server rather than a stub. It is not a
 * remote-exposure hole: 127.0.0.0/8 does not leave the host.
 */
export declare function isAllowedTailnetBindAddress(address: string): boolean;
/**
 * This machine's tailnet interface, or null when Tailscale is not up.
 *
 * Null is the honest answer for "no tailnet interface exists" and the listener
 * refuses to start on it rather than falling back to any other interface.
 */
export declare function resolveTailnetInterface(interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): TailnetInterface | null;
