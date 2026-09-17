// The one way a worker operation fails.
//
// Every request gets exactly one answer, and a failure is an answer: main is
// waiting on a `requestId` with a deadline, so a handler that throws a bare
// `Error` and lets it reach the console costs the caller twenty seconds and
// tells it nothing. Anything thrown in here carries one of the shared codes, and
// anything thrown from the editor package is mapped to one at the boundary.

import type { CanvasError, CanvasErrorCode } from '../../../shared/canvas/types'

export class CanvasWorkerError extends Error {
  readonly code: CanvasErrorCode

  constructor(code: CanvasErrorCode, message: string) {
    super(message)
    this.name = 'CanvasWorkerError'
    this.code = code
  }
}

/** Anything thrown, as an error a tool can answer with. */
export function toCanvasError(thrown: unknown, fallback: CanvasErrorCode): CanvasError {
  if (thrown instanceof CanvasWorkerError) return { code: thrown.code, message: thrown.message }
  if (thrown instanceof Error) return { code: fallback, message: thrown.message }
  return { code: fallback, message: String(thrown) }
}
