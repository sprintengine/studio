import type { MobileControlError } from './command'

export class MobileSprintEngineCommandError extends Error {
  constructor(
    readonly code: MobileControlError['code'],
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

export function getMobileSprintEngineCommandErrorMessage(error: unknown): string {
  if (error instanceof MobileSprintEngineCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}
