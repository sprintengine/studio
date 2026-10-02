import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'

// What the server asks of the desktop shell that is not an agent tool (phase 6
// spec, section 6.3). An agent's screen and terminal tools are toolsets the
// shell offers on the client-tools mechanism; what is here serves the server
// itself: sealing secrets with the OS keychain, a terminal launch for the two
// internal service tokens that name one, bringing a tab forward when a notice
// is clicked, OS notifications, the analytics sink (consent and the install id
// stay with the shell), and the gate that says the launcher and plugin home
// are written.
//
// In process the shell's services answer directly (src/main/shell-bridge.ts),
// so the flag-off path runs through this same interface. Out of process each
// member is a request on the control channel (remote.ts), served on the shell's
// side by the same in-process implementation.

/** Where a clicked notice or a deep link takes the person. */
export type ShellRevealTarget =
  /** The Remote popover: a pairing request waiting, a machine that came back. */
  | { kind: 'remote' }
  /** The app itself, brought forward. */
  | { kind: 'app' }

/** An OS notification. `activate` is where a click goes; the shell carries it out itself. */
export type ShellNotice = {
  /** A later notice with the same key replaces this one rather than stacking under it. */
  key: string
  title: string
  body?: string
  activate?: ShellRevealTarget
}

export type ShellAnalyticsEvent = { name: string; properties: Record<string, unknown> }

export type ShellBridge = {
  cipher: {
    /** Whether the OS keychain can seal now; on Linux it answers false until the app is ready. */
    available(): Promise<boolean>
    /** Seal UTF-8 bytes; the ciphertext is `safeStorage`'s, byte for byte. */
    seal(plain: Uint8Array): Promise<Uint8Array>
    open(sealed: Uint8Array): Promise<Uint8Array>
  }
  /** For the two internal service tokens that name a terminal launch; never offered to an agent. */
  terminals: { launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult> }
  /** The reveal-tab capability. False when no window could show it. */
  reveal: { tab(target: ShellRevealTarget): Promise<boolean> }
  notify(notice: ShellNotice): void
  analytics(event: ShellAnalyticsEvent): void
  /** Resolves once the shell has written the launcher and the plugin home; every agent launch waits on it. */
  integrationsReady(): Promise<void>
}

/** The control-channel method and event names the bridge travels as. */
export const SHELL_BRIDGE_METHODS = {
  cipherAvailable: 'shell.cipher.available',
  cipherSeal: 'shell.cipher.seal',
  cipherOpen: 'shell.cipher.open',
  launchAgent: 'shell.terminals.launchAgent',
  revealTab: 'shell.reveal.tab',
  integrationsReady: 'shell.integrationsReady',
} as const

export const SHELL_BRIDGE_EVENTS = {
  notify: 'shell.notify',
  analytics: 'shell.analytics',
} as const

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A string as the bytes `cipher.seal` takes. */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

/** What `cipher.open` returned, as the string it sealed. */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}
