// SSH machines are a preview until phase 8 is complete: off by default, and
// with it off no SSH code runs and Settings looks as it did before. The
// switch is read once at boot, like the server's own process switch
// (server-mode.ts): a session either has SSH machines or does not.

/** Overrides the saved switch for dev and CI: `on` or `off`. */
export const SSH_PREVIEW_ENV = 'SPRINTENGINE_SSH_MACHINES'

/** The shell-owned file the Settings switch writes; read synchronously at boot. */
export const SSH_PREVIEW_FILENAME = 'ssh-machines-preview.json'

/** How main tells a window's preload whether this session has SSH machines. */
export const SSH_PREVIEW_ARGUMENT = '--studio-ssh-machines='

export const SSH_PREVIEW_CHANNELS = {
  /** renderer → main: `{ enabled, saved, fromEnvironment }`. */
  get: 'environments:ssh:preview:get',
  /** renderer → main: save the switch for the next launch `{ enabled }`. */
  set: 'environments:ssh:preview:set',
} as const

export type SshPreviewStatus = {
  /** Whether this session has SSH machines. */
  enabled: boolean
  /** What the next launch will have. */
  saved: boolean
  /** Set for this launch by `SPRINTENGINE_SSH_MACHINES`. */
  fromEnvironment: boolean
}

export function parseSshPreview(value: unknown): boolean | null {
  if (value === true || value === false) return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'on' || normalized === '1' || normalized === 'true') return true
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return false
  return null
}

/** Whether a window's session has SSH machines, from its command line; off when none is given. */
export function sshPreviewFromArgv(argv: readonly string[]): boolean {
  const argument = argv.find((entry) => entry.startsWith(SSH_PREVIEW_ARGUMENT))
  return argument?.slice(SSH_PREVIEW_ARGUMENT.length) === 'on'
}
