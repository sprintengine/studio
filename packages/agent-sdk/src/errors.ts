/**
 * A refusal from Studio, or the client's own: `code` is the protocol's word for
 * it (`scope_required`, `ceiling_exceeded`, `unauthorized`, …), `retryAfterMs`
 * how long to wait when waiting can help.
 */
export class StudioError extends Error {
  readonly code: string
  readonly retryAfterMs?: number
  /** The id Studio logged the real cause under, when it answered in stable words instead. */
  readonly errorId?: string

  constructor(code: string, message: string, retryAfterMs?: number, errorId?: string) {
    super(message)
    this.name = 'StudioError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
    if (errorId !== undefined) this.errorId = errorId
  }
}

/** Why a connection closed for good: reconnecting cannot help until the credential or a version changes. */
export const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'revoked',
  'unsupported_protocol_version',
  'hello_required',
  'invalid_frame',
  // A pairing's token could not be kept; connecting again needs that fixed first.
  'token_not_kept',
  // The connection reached a different Studio from the one this client follows.
  'environment_changed',
])
