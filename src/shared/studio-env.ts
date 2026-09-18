/**
 * The app's own environment variables, under both of their names.
 *
 * Every one of them was spelled `MULTICODE_*` before the app was renamed
 * (2026-09-08) and is spelled `SPRINTENGINE_*` now. The rename cannot be a
 * clean break: some of these values are injected into spawned agent CLI
 * processes, and the scripts that read them there are hook copies the app has
 * already written into people's workspaces. An old copy reads the old name and
 * a new copy reads the new one, and both have to keep working.
 *
 * So: READ both, newest first ({@link readStudioEnv}). WRITE only the new name
 * where the app owns both ends ({@link studioEnvEntry}), and write both where
 * the reader is a script already on someone's disk
 * ({@link compatStudioEnvEntry}).
 */

export const ENV_PREFIX = 'SPRINTENGINE_'
export const LEGACY_ENV_PREFIX = 'MULTICODE_'

export type EnvRecord = Record<string, string | undefined>

// This module is shared, so it compiles into the renderer bundle too, where
// there is no `process` and no Node typings to describe one. Reached through
// `globalThis` rather than imported: a renderer caller gets an empty record and
// its own fallbacks, instead of a bundler shim or a build-time crash.
function processEnv(): EnvRecord {
  return (globalThis as { process?: { env?: EnvRecord } }).process?.env ?? {}
}

/**
 * What `name` used to be called, or null if it is not one of the app's own
 * variables. Every one is a straight prefix swap.
 */
export function legacyEnvName(name: string): string | null {
  if (!name.startsWith(ENV_PREFIX)) return null
  return `${LEGACY_ENV_PREFIX}${name.slice(ENV_PREFIX.length)}`
}

/** Both spellings of a variable, new first — the order every reader uses. */
export function studioEnvNames(name: string): string[] {
  const legacy = legacyEnvName(name)
  return legacy && legacy !== name ? [name, legacy] : [name]
}

/**
 * Read one of the app's variables, preferring the new name.
 *
 * Presence decides, not truthiness: a new name that is present but empty wins
 * over a legacy name that has a value, so `SPRINTENGINE_AGENT_ID=''` still
 * means "no agent" in a shell that inherited a stale `MULTICODE_AGENT_ID`. The
 * raw string comes back, empty or not, so callers keep whatever emptiness rule
 * they already had.
 */
export function readStudioEnv(name: string, env: EnvRecord = processEnv()): string | undefined {
  for (const candidate of studioEnvNames(name)) {
    if (candidate in env) return env[candidate]
  }
  return undefined
}

/**
 * Set a variable for a process whose reader ships with this app — its own child
 * processes, the MCP server. One name, the new one.
 *
 * Spreadable into an env literal, and empty for an absent value so a caller
 * writes `...studioEnvEntry(NAME, maybe)` instead of a conditional.
 */
export function studioEnvEntry(name: string, value: string | null | undefined): Record<string, string> {
  return value === null || value === undefined ? {} : { [name]: value }
}

/**
 * Set a variable for a process whose reader is NOT ours to update: the hook
 * scripts the app copied into a workspace, which stay on disk at whatever
 * version installed them and are re-read by whichever app instance launches an
 * agent next. Writes both names with the same value, so a hook copy from before
 * the rename and one from after both see it.
 *
 * This is the only reason the legacy names are still written anywhere. It stops
 * being needed once every workspace's installed hooks have been rewritten, and
 * the compat half can go with them.
 */
export function compatStudioEnvEntry(name: string, value: string | null | undefined): Record<string, string> {
  if (value === null || value === undefined) return {}
  return Object.fromEntries(studioEnvNames(name).map((candidate) => [candidate, value]))
}

/**
 * Remove every spelling of `names` from an env record, in place on a copy.
 *
 * Stripping has to cover both names or it does not strip: the app's own process
 * may have inherited a legacy-named value from the shell that launched it, and
 * clearing only the new name leaves that inherited value to be read as if the
 * caller had asked for it.
 */
export function withoutStudioEnv(env: Record<string, string>, names: readonly string[]): Record<string, string> {
  const next = { ...env }
  for (const name of names) {
    for (const candidate of studioEnvNames(name)) delete next[candidate]
  }
  return next
}
