// Where a WSL distribution keeps a CLI's files, as this (Windows) process can
// reach them. Two readers need it: the Skills tab, which lists what a CLI run
// through WSL has installed, and the agent-state installer, whose user-scoped
// registrations (Kimi's `~/.kimi-code/config.toml`) belong in the Linux home a
// WSL CLI reads, not in the Windows profile. One cached probe serves both.

import { resolveDefaultWslDistro, runWslScript, wslLoginScript, type WslScriptRunner } from './hosts/wsl-distro'

/**
 * The Linux home and the distribution root as UNC paths, and the config-home
 * variables already converted the same way.
 */
export type WslHome = { home: string; root: string; env: NodeJS.ProcessEnv }

/**
 * The marker-prefixed lines the WSL probe prints, back as a `WslHome`. A login
 * shell may print its own banner first, which is why every line we want
 * carries a prefix and anything else is ignored.
 */
export function parseWslProbe(stdout: string): WslHome | null {
  const values: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^SPRINTENGINE_WSL_([A-Z_]+)=(.+)$/u.exec(line.trim())
    if (match) values[match[1]] = match[2].trim()
  }
  if (!values.HOME || !values.ROOT) return null
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) if (values[key]) env[key] = values[key]
  return { home: values.HOME, root: values.ROOT, env }
}

/**
 * Printed by a login shell in the distribution, so the profile's own
 * `CLAUDE_CONFIG_DIR` and friends are seen. `wslpath -w` turns each Linux path
 * into the UNC path Windows opens it by. Only the first entry of a
 * comma-separated `CLAUDE_CONFIG_DIR` counts, as for every other Claude reader
 * here.
 */
const WSL_PROBE_SCRIPT = [
  `p() { [ -n "$2" ] && printf 'SPRINTENGINE_WSL_%s=%s\\n' "$1" "$(wslpath -w "$2")"; }`,
  'p HOME "$HOME"',
  'p ROOT /',
  'p CLAUDE_CONFIG_DIR "${CLAUDE_CONFIG_DIR%%,*}"',
  'p CODEX_HOME "$CODEX_HOME"',
  'p XDG_CONFIG_HOME "$XDG_CONFIG_HOME"',
  'true',
].join('; ')

// Each ask starts a login shell in the distribution, and the Skills tab asks on
// every open and on Refresh, so an answer is kept for a minute. A failure is
// not kept, so the next ask tries again.
const WSL_HOME_TTL_MS = 60_000
const WSL_HOME_TIMEOUT_MS = 10_000

export type WslHomeProbe = (distro?: string | null) => Promise<WslHome | null>

export function createWslHomeProbe(
  deps: {
    run?: WslScriptRunner
    resolveDefaultDistro?: () => Promise<string | null>
    now?: () => number
    ttlMs?: number
  } = {},
): WslHomeProbe {
  const run = deps.run ?? runWslScript
  const resolveDefaultDistro = deps.resolveDefaultDistro ?? (() => resolveDefaultWslDistro())
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? WSL_HOME_TTL_MS
  const cache = new Map<string, { at: number; value: Promise<WslHome | null> }>()
  return async (requested) => {
    const distro = requested ?? (await resolveDefaultDistro().catch(() => null))
    const key = distro ?? ''
    const cached = cache.get(key)
    if (cached && now() - cached.at < ttlMs) return cached.value
    const value = run(distro, wslLoginScript(`{\n${WSL_PROBE_SCRIPT}\n} </dev/null`), {
      timeoutMs: WSL_HOME_TIMEOUT_MS,
    })
      .then((outcome) => (outcome.code === 0 && !outcome.timedOut ? parseWslProbe(outcome.stdout) : null))
      .catch(() => null)
    const entry = { at: now(), value }
    cache.set(key, entry)
    void value.then((result) => {
      if (!result && cache.get(key) === entry) cache.delete(key)
    })
    return value
  }
}

/** The app's one cached probe. */
export const probeWslHome: WslHomeProbe = createWslHomeProbe()
