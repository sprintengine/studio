import { userInfo } from 'os'
import { delimiter } from 'path'

import { captureLoginEnv } from '../../../resources/wsl-helper/lib/login-env.mjs'
import { withoutInheritedSessionEnv } from '../inherited-session-env'
import { searchDirectories } from '../login-shell-path'

/**
 * The environment a worktree's dependency install runs with
 * (dependency-install.ts): the person's whole login environment, as their own
 * terminal has it, less the app's own variables.
 *
 * An app opened from the Dock, the Start menu or a desktop launcher does not
 * inherit what a shell profile exports, and a PATH alone is not enough for an
 * install: a private registry reads its token from `NPM_TOKEN` (or whatever
 * name `.npmrc` interpolates), a company network needs `HTTPS_PROXY`, and a
 * TLS-intercepting proxy needs `NODE_EXTRA_CA_CERTS`. None of those names can
 * be listed in advance, so nothing is picked: one login shell (interactive for
 * bash, zsh and the ksh family, where version managers and most exports live;
 * a plain login shell for fish and the rest) prints its environment, and all
 * of it is kept but the app's own variables.
 *
 * A lease asks for it whenever the plan gets that far: a JavaScript project's
 * fingerprint carries the Node version the install would run under, which is
 * the login PATH's `node`. A login shell sourcing a profile that loads a
 * version manager can take a second, so what it printed is kept for a few
 * minutes (`cachedDependencyInstallEnvironment`): a burst of leases, almost
 * all of which install nothing, starts one shell between them. An export added
 * to a profile counts once that has run out. A shell that could not be read is
 * not kept, and an install that failed drops what was (dependency-install.ts),
 * so the next lease asks again: a missing token may have been added since.
 *
 * The login shell's PATH comes first and this process's follows, so a
 * directory only the app knows (a managed runtime) is still found. On Windows
 * there is no login shell to ask, and the app's environment is what an
 * installer gets, as before.
 */

/** Names an install never gets: the app's own, and the process's own bookkeeping. */
export function isAppOwnVariable(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    upper.startsWith('SPRINTENGINE_') ||
    upper === 'ELECTRON_RUN_AS_NODE' ||
    // The directory the probing shell started in, not the worktree.
    upper === 'PWD' ||
    upper === 'OLDPWD'
  )
}

function cleaned(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && !isAppOwnVariable(name)) kept[name] = value
  }
  // Markers a parent agent session stamps on this process when it started the app.
  return withoutInheritedSessionEnv(kept)
}

export type LoginEnvironmentCapture = (input: {
  shell: string
  env: Record<string, string>
  keep: (name: string) => boolean
}) => Promise<Record<string, string>>

export type InstallEnvironmentDeps = {
  platform?: NodeJS.Platform
  processEnv?: Record<string, string | undefined>
  /** The person's login shell; `$SHELL`, else the account's, else `/bin/sh`. */
  shell?: () => string
  capture?: LoginEnvironmentCapture
}

const defaultCapture: LoginEnvironmentCapture = ({ shell, env, keep }) => captureLoginEnv({ shell, env, keep })

function defaultShell(env: Record<string, string | undefined>): string {
  const fromEnv = env.SHELL?.trim()
  if (fromEnv) return fromEnv
  try {
    const account = userInfo().shell?.trim()
    if (account) return account
  } catch {
    // No account entry to read.
  }
  return '/bin/sh'
}

export async function dependencyInstallEnvironment(deps: InstallEnvironmentDeps = {}): Promise<NodeJS.ProcessEnv> {
  return (await readInstallEnvironment(deps)).env
}

/** The environment, and whether it is whole: false when the login shell could not be read. */
async function readInstallEnvironment(
  deps: InstallEnvironmentDeps,
): Promise<{ env: NodeJS.ProcessEnv; whole: boolean }> {
  const platform = deps.platform ?? process.platform
  const processEnv = deps.processEnv ?? process.env
  const base = cleaned(processEnv)
  if (platform === 'win32') return { env: base, whole: true }
  const shell = deps.shell?.() ?? defaultShell(processEnv)
  // The shell starts from the cleaned environment, so nothing of the app's
  // reaches its profile, and what comes back is filtered again in case a
  // profile sets one of them itself.
  const login = await (deps.capture ?? defaultCapture)({
    shell,
    env: base,
    keep: (name) => !isAppOwnVariable(name),
  }).catch(() => null)
  const merged = cleaned({ ...base, ...login })
  const path = searchDirectories(login?.PATH ?? null, base.PATH).join(delimiter)
  if (path) merged.PATH = path
  return { env: merged, whole: login !== null }
}

/** How long a login shell's environment is kept before the next lease asks again. */
export const INSTALL_ENVIRONMENT_FRESH_MS = 5 * 60_000

export type CachedInstallEnvironment = {
  /** The environment: the one kept while it is fresh (or still being read), else a new read. */
  read(): Promise<NodeJS.ProcessEnv>
  /** Drop what is kept, so the next read asks the login shell again. */
  forget(): void
}

/**
 * `dependencyInstallEnvironment`, kept for `freshMs` (one per process, made
 * where the installer is). Leases that ask while a read is under way share
 * it. A read whose login shell could not be read is not kept.
 */
export function cachedDependencyInstallEnvironment(
  deps: InstallEnvironmentDeps & { freshMs?: number; now?: () => number } = {},
): CachedInstallEnvironment {
  const now = deps.now ?? Date.now
  const freshMs = deps.freshMs ?? INSTALL_ENVIRONMENT_FRESH_MS
  let kept: { at: number; env: Promise<NodeJS.ProcessEnv> } | null = null
  return {
    read() {
      const at = now()
      if (kept && at - kept.at < freshMs) return kept.env
      const entry: { at: number; env: Promise<NodeJS.ProcessEnv> } = {
        at,
        env: readInstallEnvironment(deps).then(({ env, whole }) => {
          if (!whole && kept === entry) kept = null
          return env
        }),
      }
      kept = entry
      return entry.env
    },
    forget() {
      kept = null
    },
  }
}
