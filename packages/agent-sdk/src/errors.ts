/**
 * A refusal from Studio, or the client's own: `code` is the protocol's word for
 * it (`scope_required`, `ceiling_exceeded`, `unauthorized`, …), `retryAfterMs`
 * how long to wait when waiting can help.
 */
export class StudioError extends Error {
  readonly code: string
  readonly retryAfterMs?: number

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'StudioError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

/** Why a connection closed for good: reconnecting cannot help until the credential or a version changes. */
export const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'revoked',
  'unsupported_protocol_version',
  'hello_required',
  'invalid_frame',
])
