import type { MobileControlError } from './command'

export class MobileControlCommandError extends Error {
  constructor(
    readonly code: MobileControlError['code'],
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

export function getMobileControlCommandErrorMessage(error: unknown): string {
  if (error instanceof MobileControlCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}
