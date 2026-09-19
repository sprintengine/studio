/** The app's own environment variables, all spelled `SPRINTENGINE_*`. */

export type EnvRecord = Record<string, string | undefined>

// This module is shared, so it compiles into the renderer bundle too, where
// there is no `process` and no Node typings to describe one. Reached through
// `globalThis` rather than imported: a renderer caller gets an empty record and
// its own fallbacks, instead of a bundler shim or a build-time crash.
function processEnv(): EnvRecord {
  return (globalThis as { process?: { env?: EnvRecord } }).process?.env ?? {}
}

/**
 * Read one of the app's variables. The raw string comes back, empty or not, so
 * callers keep whatever emptiness rule they already had.
 */
export function readStudioEnv(name: string, env: EnvRecord = processEnv()): string | undefined {
  return env[name]
}

/**
 * Set a variable for a child process. Spreadable into an env literal, and empty
 * for an absent value so a caller writes `...studioEnvEntry(NAME, maybe)`
 * instead of a conditional.
 */
export function studioEnvEntry(name: string, value: string | null | undefined): Record<string, string> {
  return value === null || value === undefined ? {} : { [name]: value }
}

/** Remove `names` from an env record, on a copy. */
export function withoutStudioEnv(env: Record<string, string>, names: readonly string[]): Record<string, string> {
  const next = { ...env }
  for (const name of names) delete next[name]
  return next
}
