// Types for login-env.mjs, which the Studio server inside a WSL distribution
// bundles too (phase 7): the same capture of the person's login environment,
// shared rather than copied.

export function keepVariable(name: string): boolean
export function parseEnvDump(bytes: Buffer | string): Record<string, string> | null
export function loginShell(uid: number, passwd?: () => string): string
export function captureLoginEnv(options?: {
  uid?: number
  baseEnv?: Record<string, string | undefined>
  timeoutMs?: number
  shell?: string
}): Promise<Record<string, string>>
