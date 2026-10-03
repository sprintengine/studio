// How the Windows side runs things in a WSL distribution: a shell with its
// script on stdin, a script to completion, or one argv (`tar`) with a body
// streamed to its stdin. One shape for the helper's install and the Studio
// server's start, so the server's tests can stand a plain `sh` in for
// `wsl.exe` the way the helper's do.

import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

import { killProcessTree } from '../process-tree-kill'
import type { RunOutcome } from '../process-run'
import type { HelperProcess } from './wsl-helper-client'
import { decodeWslOutput, runWslScript, wslDistroArgs } from './wsl-distro'

export type WslRunner = {
  /** `wsl.exe -d <distro> --cd ~ --exec sh -s`, all three pipes open; the caller writes the script. */
  spawnShell(distro: string): HelperProcess
  /** A script run by `sh -s` in the Linux home, to completion. */
  runScript(distro: string, script: string, options: { timeoutMs: number | null }): Promise<RunOutcome>
  /** `wsl.exe -d <distro> --cd ~ --exec <argv>` with `body` streamed to its stdin. */
  runExec(distro: string, argv: readonly string[], body: Buffer | Readable, timeoutMs: number): Promise<RunOutcome>
}

function spawnShell(distro: string): HelperProcess {
  const child = spawn('wsl.exe', [...wslDistroArgs(distro), '--cd', '~', '--exec', 'sh', '-s'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => undefined)
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => killProcessTree(child),
    once: (event: 'close' | 'error', listener: (...args: never[]) => void) =>
      child.once(event, listener as (...args: unknown[]) => void),
  } as HelperProcess
}

function runExec(
  distro: string,
  argv: readonly string[],
  body: Buffer | Readable,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', [...wslDistroArgs(distro), '--cd', '~', '--exec', ...argv], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: '', stderr: error.message, timedOut: false, spawnFailed: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: decodeWslOutput(Buffer.concat(out)),
        stderr: decodeWslOutput(Buffer.concat(err)),
        timedOut,
      })
    })
    if (Buffer.isBuffer(body)) child.stdin.end(body)
    else body.pipe(child.stdin)
  })
}

/** The real thing: `wsl.exe` on this PC. */
export const wslExeRunner: WslRunner = {
  spawnShell,
  runScript: (distro, script, options) => runWslScript(distro, script, options),
  runExec,
}
