import type { MobileControlError } from './mobile-sprintengine-command'

export class MobileSwarmCommandError extends Error {
  constructor(
    readonly code: MobileControlError['code'],
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

export function getMobileSwarmCommandErrorMessage(error: unknown): string {
  if (error instanceof MobileSwarmCommandError) return error.message
  return error instanceof Error ? error.message : String(error)
}
