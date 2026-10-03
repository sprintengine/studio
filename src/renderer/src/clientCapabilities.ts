import { DESKTOP_CLIENT_CAPABILITIES, type ClientCapability } from '../../shared/client-capabilities'

// Ask the shell this renderer runs in what it can do (phase 9 spec, 3.4), and
// which machine is which (3.3). A desktop window answers from its preload, a
// browser tab from feature detection. A `window.api` that predates the
// question (a test's stand-in, an older preload) is a desktop window's.

type ShellFacts = { clientCapabilities?: readonly ClientCapability[]; platform?: string; hostPlatform?: string }

function shell(): ShellFacts | undefined {
  return typeof window === 'undefined' ? undefined : (window.api as ShellFacts | undefined)
}

// Read defensively: a test's stand-in may answer any member with a function.
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function clientSupports(capability: ClientCapability, api: ShellFacts | undefined = shell()): boolean {
  const declared = api?.clientCapabilities
  return (Array.isArray(declared) ? declared : DESKTOP_CLIENT_CAPABILITIES).includes(capability)
}

/** The OS of the machine the person is at: keyboards, modifiers, window chrome. */
export function clientPlatform(api: ShellFacts | undefined = shell()): string {
  return text(api?.platform) ?? ''
}

/** The OS of the machine the Studio server runs on: paths, "Reveal in Finder", CLI hints. */
export function hostPlatform(api: ShellFacts | undefined = shell()): string {
  return text(api?.hostPlatform) ?? text(api?.platform) ?? ''
}
