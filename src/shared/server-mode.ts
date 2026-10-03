// Where the Studio server runs this session (phase 6 spec, section 7.3): in
// main as it always has (`in-process`), or in a utility process of its own
// (`out-of-process`). Chosen once, at boot, before anything is built: one
// writer per file for the whole session.
//
// In process stays the default until the flip criteria are met (decision
// R04): a release of dogfooding with no FAILED reports, and the macOS Local
// Network check on a packaged, notarized build.

export type ServerMode = 'in-process' | 'out-of-process'

export const DEFAULT_SERVER_MODE: ServerMode = 'in-process'

/** Overrides `server-mode.json` for dev and CI. */
export const SERVER_MODE_ENV = 'SPRINTENGINE_SERVER_MODE'

/** The shell-owned file the Advanced toggle writes; read synchronously at boot. */
export const SERVER_MODE_FILENAME = 'server-mode.json'

/** How main tells a window's preload the mode: a command-line switch on the renderer. */
export const SERVER_MODE_ARGUMENT = '--studio-server-mode='

export function parseServerMode(value: unknown): ServerMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'in-process' || normalized === 'out-of-process') return normalized
  return null
}

/** The mode a renderer was started in, from its command line; in process when none is given. */
export function serverModeFromArgv(argv: readonly string[]): ServerMode {
  const argument = argv.find((entry) => entry.startsWith(SERVER_MODE_ARGUMENT))
  return parseServerMode(argument?.slice(SERVER_MODE_ARGUMENT.length)) ?? DEFAULT_SERVER_MODE
}
