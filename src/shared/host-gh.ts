// GitHub CLI (`gh`) on a machine other than this one: a WSL distribution or an
// SSH machine. A chat there opens its pull requests with that machine's `gh`,
// and the pull request marks for its chats are looked up with it, so Settings
// says whether it is there and signed in, and what to do when it is not.
//
// Studio never signs anyone in: it names the command, and the person runs it.

/** What one machine's `gh` is, as far as a read-only check can tell. */
export type HostGhStatus = {
  /** False when `gh` is not on the machine's login PATH. */
  installed: boolean
  /** `gh --version`'s number, when it said one. */
  version: string | null
  /**
   * Whether `gh` holds a token for github.com (`gh auth token` succeeds; the
   * token itself is never read back). Null when it could not be told.
   */
  signedIn: boolean | null
}

/** Why the row is there at all. */
export const GH_NEEDED_FOR = 'Needed to open pull requests and show pull request marks for chats on this machine.'

/** Where the GitHub CLI's own install instructions are, for a machine whose package manager cannot be named. */
export const GH_INSTALL_URL = 'https://github.com/cli/cli#installation'

/** The kind of machine a `gh` row is for: its install and sign-in commands differ. */
export type HostGhMachine = { kind: 'wsl' } | { kind: 'ssh'; os: string | null }

/**
 * The install hint for a machine without `gh`: Homebrew on a Mac, where it is
 * the one honest command, and the GitHub CLI's own instructions anywhere else,
 * where apt, dnf, pacman and the rest would each be a guess.
 */
export function ghInstallHint(machine: HostGhMachine): { command: string | null; url: string } {
  if (machine.kind === 'ssh' && machine.os === 'Darwin') return { command: 'brew install gh', url: GH_INSTALL_URL }
  return { command: null, url: GH_INSTALL_URL }
}

/**
 * The sign-in commands for a machine whose `gh` is not signed in, run by the
 * person in a terminal there. Inside WSL, the Windows sign-in can be reused:
 * `gh.exe` is This PC's `gh`, reachable from the distribution.
 */
export function ghSignInCommands(machine: HostGhMachine): string[] {
  return machine.kind === 'wsl'
    ? ['gh auth login', 'gh.exe auth token | gh auth login --with-token']
    : ['gh auth login']
}

/** The first `x.y.z` in `gh --version`'s output (`gh version 2.62.0 (2024-11-14)`), or null. */
export function parseGhVersion(output: string): string | null {
  return /\bgh version (\d+\.\d+(?:\.\d+)?)/u.exec(output)?.[1] ?? null
}
