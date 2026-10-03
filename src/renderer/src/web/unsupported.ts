// What a web tab answers for a `window.api` member that has no meaning in a
// browser (phase 9 spec, 3.2): an explicit refusal, never an absent member and
// never a synchronous throw. A call is a rejected promise carrying
// `UnsupportedOnThisClient`; a subscription is a no-op whose unsubscribe works.
//
// Each refused channel is noted once. The list is the "missing-member report":
// a walk through the chat route in a browser should leave it empty of anything
// the chat needs.

export const UNSUPPORTED_ON_THIS_CLIENT = 'UnsupportedOnThisClient'

export class UnsupportedOnThisClient extends Error {
  readonly channel: string
  constructor(channel: string) {
    super(`${channel} is not available in a browser.`)
    this.name = UNSUPPORTED_ON_THIS_CLIENT
    this.channel = channel
  }
}

const refused = new Set<string>()

/** Note a refusal, once per channel, and return the error to reject with. */
export function refuse(channel: string): UnsupportedOnThisClient {
  if (!refused.has(channel)) {
    refused.add(channel)
    console.info(`[web] ${channel} is not available in a browser`)
  }
  return new UnsupportedOnThisClient(channel)
}

/** Every channel refused so far, in the order first asked for. */
export function refusedChannels(): string[] {
  return [...refused]
}

export function isUnsupportedOnThisClient(error: unknown): error is UnsupportedOnThisClient {
  return error instanceof Error && error.name === UNSUPPORTED_ON_THIS_CLIENT
}
