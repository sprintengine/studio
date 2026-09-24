// Running a program for main: an argv, never a shell string, always bounded.
//
// Each child is its own process group, so a deadline ends everything it
// started (a git hook, an installer's subprocesses) and not just the first
// process. Every live group is also ended when the helper exits, so nothing it
// started outlives it and keeps the WSL VM awake.

import { spawn } from 'node:child_process'

// Output past this is dropped and the result says so. A git diff of a large
// change is the biggest thing that comes back through here.
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

const liveGroups = new Set()

/** A process group the helper started some other way, ended on the way out too. */
export function trackGroup(pid) {
  if (pid) liveGroups.add(pid)
}

export function untrackGroup(pid) {
  liveGroups.delete(pid)
}

/** Ends every process group still running. Called on the way out. */
export function killAllChildren() {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear()
}

/** A request's `stdinB64` as bytes: undefined when absent, null when it is not base64 text. */
export function decodeStdin(stdinB64) {
  if (stdinB64 === undefined) return undefined
  if (typeof stdinB64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(stdinB64)) return null
  return Buffer.from(stdinB64, 'base64')
}

/** Validates a run request's shape; returns an error message or null. */
export function checkRunRequest({ argv, cwd, timeoutMs, env }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string')) {
    return 'argv must be a non-empty array of strings.'
  }
  if (argv.some((arg) => arg.includes('\0'))) return 'argv must not contain NUL bytes.'
  if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.startsWith('/'))) return 'cwd must be an absolute path.'
  if (timeoutMs !== null && (typeof timeoutMs !== 'number' || !(timeoutMs > 0))) {
    return 'timeoutMs must be a positive number, or null for no deadline.'
  }
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return 'env must be an object.'
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME.test(name) || typeof value !== 'string') return `env entry "${name}" is not a plain variable.`
    }
  }
  return null
}

/**
 * Runs `argv` in `cwd` with `env`. `stdin` (a Buffer) is written to the child
 * and closed; without it stdin is closed from the start. `timeoutMs` null means
 * no deadline: a git write runs the repository's hooks, and killing one
 * part-way leaves a lock file behind.
 */
export function runArgv({ argv, cwd, env, timeoutMs, stdin }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? process.env.HOME ?? '/',
        env,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnFailed: true })
      return
    }
    liveGroups.add(child.pid)
    if (stdin && child.stdin) {
      // A child that exits before reading everything (`git apply` refusing a
      // patch) closes the pipe; that is its answer, not an error of ours.
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let outTruncated = false
    let errTruncated = false
    let timedOut = false
    let settled = false
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              // Gone already.
            }
          }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (outTruncated) return
      if (outBytes + chunk.length > MAX_OUTPUT_BYTES) {
        outTruncated = true
        return
      }
      outBytes += chunk.length
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (errTruncated) return
      if (errBytes + chunk.length > MAX_OUTPUT_BYTES) {
        errTruncated = true
        return
      }
      errBytes += chunk.length
      err.push(chunk)
    })
    const settle = (outcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      liveGroups.delete(child.pid)
      resolve(outcome)
    }
    child.on('error', (error) => {
      settle({ code: 127, stdout: '', stderr: String(error?.message ?? error), timedOut: false, spawnFailed: true })
    })
    const finish = (code, signal) =>
      settle({
        code: typeof code === 'number' ? code : signal ? 128 + 9 : 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        ...(outTruncated || errTruncated ? { truncated: true } : {}),
      })
    child.on('close', finish)
    // Something the program started (a daemon a `--version` spawns) can hold
    // its output pipe open after it exits. The answer is settled without it,
    // and the group, which that something is still in, is ended.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        if (settled) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Gone.
        }
        finish(code, signal)
      }, 2_000).unref()
    })
  })
}

/** An environment for a child: the person's kept variables, then the request's own. */
export function childEnv(loginEnv, extra) {
  const env = { ...loginEnv }
  for (const [name, value] of Object.entries(extra ?? {})) if (ENV_NAME.test(name)) env[name] = value
  return env
}
