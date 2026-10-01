// The person's own environment, read once from their login shell.
//
// `wsl.exe --exec` starts the helper with almost nothing: no profile has run,
// so PATH lacks `~/.local/bin`, nvm's node and every other place CLIs live,
// and nothing git's credential setup exports (an ssh agent's socket, a GitHub
// token) is there. A CLI check or a git command run from that environment
// would say "not installed" or fail to authenticate for a person whose own
// terminal works fine.
//
// So once per helper start, one login shell prints its environment and the
// helper keeps a fixed list of variables from it: PATH and the locale, and the
// ones git, ssh and the forges read. Nothing outside that list is kept, and
// none of it is ever logged or sent to main.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { trackGroup, untrackGroup } from './run.mjs'

const EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'GNUPGHOME',
  'GPG_AGENT_INFO',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'GCM_CREDENTIAL_STORE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'NVM_DIR',
  'NVM_BIN',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'NPM_CONFIG_PREFIX',
  'npm_config_prefix',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
])
// Every `GIT_*` (committer identity, ssh command, askpass, config paths) and
// the locale categories.
const PREFIXES = ['GIT_', 'LC_']

export function keepVariable(name) {
  return EXACT.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix))
}

const SENTINEL = '__SPRINTENGINE_ENV__'

/** `env -0` output after the sentinel, as the kept variables. */
export function parseEnvDump(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)
  const marker = `\0${SENTINEL}\0`
  const start = text.lastIndexOf(marker)
  if (start < 0) return null
  const env = {}
  for (const entry of text.slice(start + marker.length).split('\0')) {
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const name = entry.slice(0, equals)
    if (keepVariable(name)) env[name] = entry.slice(equals + 1)
  }
  return env
}

/** The person's login shell, from the password database; bash when unreadable. */
export function loginShell(uid, passwd = () => readFileSync('/etc/passwd', 'utf8')) {
  try {
    for (const line of passwd().split('\n')) {
      const fields = line.split(':')
      if (fields.length >= 7 && Number(fields[2]) === uid && fields[6].startsWith('/')) return fields[6].trim()
    }
  } catch {
    // Fall through.
  }
  return '/bin/bash'
}

const TIMED_OUT = Symbol('timed out')

// Settles on the deadline whatever the shell does: something a profile
// starts in a session of its own can hold the output pipe open long after
// the shell itself is gone, and nothing may wait on that.
function dump(shell, flags, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(shell, [...flags, `printf '\\0${SENTINEL}\\0'; env -0`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
    } catch {
      resolve(null)
      return
    }
    trackGroup(child.pid)
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      untrackGroup(child.pid)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Gone.
      }
      child.stdout.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(TIMED_OUT), timeoutMs)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size <= 4 * 1024 * 1024) chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(parseEnvDump(Buffer.concat(chunks))))
    // The shell exited but something it started still holds the pipe: what
    // it printed is all there is.
    child.on('exit', () => {
      setTimeout(() => finish(parseEnvDump(Buffer.concat(chunks))), 1_000).unref()
    })
  })
}

/**
 * The kept variables from an interactive login shell (where nvm and most
 * version managers set PATH up), else a plain login shell, else the helper's
 * own environment. Always has a PATH.
 */
export async function captureLoginEnv({ uid, baseEnv = process.env, timeoutMs = 8_000, shell } = {}) {
  const chosen = shell ?? loginShell(uid)
  const name = chosen.split('/').at(-1) ?? ''
  // `-i` loads the interactive rc files (`.bashrc`, `.zshrc`), which is where a
  // version manager usually puts its PATH. Shells that do not know the flag
  // combination fall back to a plain login shell.
  const attempts = ['bash', 'zsh', 'ksh', 'mksh'].includes(name)
    ? [
        ['-l', '-i', '-c'],
        ['-l', '-c'],
      ]
    : [['-l', '-c']]
  for (const flags of attempts) {
    const env = await dump(chosen, flags, timeoutMs)
    // A shell that hangs would hang again: one deadline is all it gets, so
    // the first request after a start never waits more than that.
    if (env === TIMED_OUT) break
    if (env && env.PATH) return env
  }
  const fallback = {}
  for (const [name, value] of Object.entries(baseEnv))
    if (keepVariable(name) && value !== undefined) fallback[name] = value
  if (!fallback.PATH) fallback.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  return fallback
}
