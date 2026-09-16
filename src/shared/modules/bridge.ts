// Renderer→module-main IPC bridge contract. A module's renderer code invokes
// channels its own `entry.main` registered via `MainHost.registerIpc`, through
// the single host-owned dispatcher channel below. This is a contract, not a
// security boundary: all renderer code shares one world and can already reach
// `window.api`; trust gating (only `trusted` modules execute) remains the
// actual boundary.

export const MODULE_BRIDGE_INVOKE_CHANNEL = 'modules:bridge:invoke'

export type ModuleBridgeInvokeRequest = {
  /** Target channel; must be `<ownerModuleId>:`-prefixed and registered via registerIpc. */
  channel: string
  payload?: unknown
}

export type ModuleBridgeRefusalCode = 'unknown_channel' | 'not_bridgeable' | 'permission_missing'

// Refusals are structured data, never rejections across IPC — Electron mangles
// thrown errors into opaque "Error invoking remote method" strings. Handler
// results and handler throws keep their normal invoke semantics.
export type ModuleBridgeInvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; code: ModuleBridgeRefusalCode; message: string }
