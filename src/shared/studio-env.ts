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

// The identity vars an agent launch owns (see `applyAgentIdentityEnv` in
// terminal-launch.ts). Cleared from a base env before the session's own
// identity is applied, so a stale `SPRINTENGINE_AGENT_ID` inherited by the app's
// own process (e.g. the app launched from inside an agent shell) never leaks
// into a plain terminal or the wrong agent. Shared because a launch through WSL
// must also name exactly these in `WSLENV` for them to reach the agent at all.
export const AGENT_IDENTITY_ENV_KEYS = [
  'SPRINTENGINE_WORKSPACE_ID',
  'SPRINTENGINE_AGENT_ID',
  'SPRINTENGINE_AGENT_NAME',
  'SPRINTENGINE_AGENT_STATE_SOCKET',
  'SPRINTENGINE_AGENT_CLI',
] as const
