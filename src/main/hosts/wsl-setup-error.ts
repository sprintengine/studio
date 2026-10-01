// Why a WSL machine could not be used, in words a person can act on.
//
// Setting a distribution up can fail two ways, and they are handled apart:
//
//   - Transient: the WSL VM is still booting, `wsl.exe` timed out on a cold
//     start, the distribution is mid-update. Retried a few times with a
//     pre-warm (`wsl.exe -d <distro> --exec true`) and a backoff before it is
//     reported.
//   - Fatal: WSL is not installed, the distribution is gone, there is no
//     network for the one-time Node.js download, the download did not match
//     its checksum, or Node.js cannot run there. Retrying immediately cannot
//     help, so the launch fails at once with the reason, and the next attempt
//     waits a while before trying again.
//
// There is no fallback to anything else: a WSL launch either runs with the
// helper or says why it cannot.

export type WslSetupErrorCode =
  | 'wsl-missing'
  | 'distro-missing'
  | 'node-download'
  | 'node-checksum'
  | 'node-run'
  | 'unsupported-arch'
  | 'install'
  | 'protocol'
  | 'start'
  | 'stopped'

export class WslSetupError extends Error {
  readonly fatal: boolean
  readonly code: WslSetupErrorCode

  constructor(message: string, options: { fatal: boolean; code: WslSetupErrorCode }) {
    super(message)
    this.name = 'WslSetupError'
    this.fatal = options.fatal
    this.code = options.code
  }
}

export function isWslSetupError(error: unknown): error is WslSetupError {
  return error instanceof WslSetupError
}
