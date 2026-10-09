// The host API version: one integer the app and a module agree on, so a module
// built against a newer contract is refused with a message instead of failing
// at the first call the host does not have.
//
// Pure (no Node APIs, no values imported from index) and safe in any runtime.

import type { CapabilityManifest } from './index.js'

/**
 * The host API this SDK describes. A module declares the version it was built
 * against as `engines.hostApi` in its manifest; the host loads it when that
 * number is within `[HOST_API_MIN_SUPPORTED, HOST_API_VERSION]`.
 */
export const HOST_API_VERSION = 1

/** The oldest host API a host still loads modules for. */
export const HOST_API_MIN_SUPPORTED = 1

/**
 * A feature a module can ask the running host about with `host.supports(...)`
 * before it relies on it. The version number says which contract a module was
 * built for; this says what the host in front of it actually provides today
 * (a service can be absent because its providing module is off). Unknown names
 * answer `false`, so a module may probe for capabilities newer than its SDK.
 */
export type HostCapability =
  | 'conversations'
  // The conversation service's controls: all four permission presets,
  // `setPermissionPreset`, `setModel` and approval `decision`s.
  | 'conversation-controls'
  // `follow` (a snapshot or the events after a cursor, a `synchronized`
  // fence, then live events) and a `commandId` on every mutating call.
  | 'conversation-streams'
  // `answerQuestion` and `resolvePlan`, each refused for a request of another kind.
  | 'conversation-requests'
  // The agent CLI's own `permissionMode` beside the preset, and `allowedTools` at `create`.
  | 'conversation-permissions'
  | 'chat.open'
  | 'companion-agents'
  // ── Agents, conversations and scheduled agents ──
  // A companion's structured run takes `tools` ('none' by default, 'ask',
  // 'auto'), its handle `respondToApproval`, and its engine a chat runtime id.
  | 'companion-tools'
  // `turn_completed` carries `text` and `usage`, and the conversation service
  // has `reply(ref, turnId?)`.
  | 'conversation-replies'
  // `getTextGenerationService(host).generate`: one prompt, no chat.
  | 'text-generation'
  | 'scheduled-agents'
  | 'secrets'
  | 'github'
  | 'storage'
  | 'mcp-tools'
  | 'skills'
  | 'module-assets'
  | 'notifications'
  // `entry.main` runs in the desktop's own main process, where `electron` can
  // be required. False wherever the main half runs in the Studio server, a
  // Node process with no Electron APIs; a module that cannot live without them
  // declares `requires.hostCapabilities: ['electron-main']` and runs only where
  // this is true.
  | 'electron-main'
  | (string & {})

export type HostApiCompatibility =
  { ok: true } | { ok: false; code: 'host_api_missing' | 'host_api_too_new' | 'host_api_too_old'; message: string }

/**
 * Whether this host can load a module with this manifest. A third-party module
 * must declare `engines.hostApi`; a bundled (first-party) one ships with the
 * host it runs on, so an absent `engines` is compatible by construction.
 */
export function checkHostApiCompatibility(
  manifest: Pick<CapabilityManifest, 'engines' | 'source'>,
): HostApiCompatibility {
  const hostApi = manifest.engines?.hostApi
  if (hostApi === undefined) {
    if (manifest.source !== 'third-party') return { ok: true }
    return {
      ok: false,
      code: 'host_api_missing',
      message: `The module does not say which host API it was built for; add "engines": { "hostApi": ${HOST_API_VERSION} } to its manifest.`,
    }
  }
  // A manifest is JSON someone wrote by hand: `"1"` or `1.5` is no version at all.
  if (typeof hostApi !== 'number' || !Number.isInteger(hostApi)) {
    return {
      ok: false,
      code: 'host_api_missing',
      message: `The module's "engines.hostApi" must be a whole number, such as ${HOST_API_VERSION}.`,
    }
  }
  if (hostApi > HOST_API_VERSION) {
    return {
      ok: false,
      code: 'host_api_too_new',
      message: `The module needs host API ${hostApi}, and this version of the app provides ${HOST_API_VERSION}. Update the app to use it.`,
    }
  }
  if (hostApi < HOST_API_MIN_SUPPORTED) {
    return {
      ok: false,
      code: 'host_api_too_old',
      message: `The module was built for host API ${hostApi}, and this version of the app loads ${HOST_API_MIN_SUPPORTED} or newer. Rebuild it against a current SDK.`,
    }
  }
  return { ok: true }
}
