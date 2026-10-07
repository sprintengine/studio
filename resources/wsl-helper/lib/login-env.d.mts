// Types for login-env.mjs, which the Studio server inside a WSL distribution
// bundles too (phase 7): the same capture of the person's login environment,
// shared rather than copied.

export function keepVariable(name: string): boolean
export function parseEnvDump(bytes: Buffer | string, keep?: (name: string) => boolean): Record<string, string> | null
export function loginShell(uid: number, passwd?: () => string): string
export function captureLoginEnv(options?: {
  uid?: number
  baseEnv?: Record<string, string | undefined>
  timeoutMs?: number
  shell?: string
  /** Which variables to keep; the fixed list `keepVariable` answers when absent. */
  keep?: (name: string) => boolean
  /** The environment the shell starts with; this process's when absent. */
  env?: Record<string, string | undefined>
}): Promise<Record<string, string>>
