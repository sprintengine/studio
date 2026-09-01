import { utilityProcess } from 'electron'

import { bundleScriptEnv } from './bundle-script-env'
import type { BundleScriptExit, BundleScriptFork } from './derived-file-runner'

// Bundle generator scripts run in an Electron utility process, never in the
// main process itself — the same trust boundary as the bypass designer
// session that authored them. Verified against Electron 41: utilityProcess
// forks bundle-local .mjs entry points, and the scripts terminate themselves
// with an explicit flush-then-exit (the parent IPC port would otherwise keep
// their event loop alive forever — the timeout below is the backstop for a
// script that does not honor that contract).
const SCRIPT_TIMEOUT_MS = 30_000

// 'exit' can fire before the final stdio chunks are delivered; wait briefly
// for the pipes to close so failure stderr is never truncated.
const STREAM_DRAIN_GRACE_MS = 500

function streamClosed(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    stream.once('close', resolve)
    stream.once('end', resolve)
  })
}

export const forkBundleScriptInUtilityProcess: BundleScriptFork = (scriptPath, args, options) =>
  new Promise<BundleScriptExit>((resolve) => {
    let child: Electron.UtilityProcess
    try {
      // Bundle scripts never see the full main-process env — only the
      // minimal allowlist (bundle-script-env.ts): main-env secrets must not
      // leak into every generator script the runner executes.
      child = utilityProcess.fork(scriptPath, args, {
        cwd: options.cwd,
        stdio: 'pipe',
        env: bundleScriptEnv(process.env),
      })
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `failed to fork ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const drained = Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)])

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[design-system] ${scriptPath} timed out after ${SCRIPT_TIMEOUT_MS}ms and was killed`,
      })
    }, SCRIPT_TIMEOUT_MS)

    child.once('exit', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void Promise.race([
        drained,
        new Promise((graceOver) => setTimeout(graceOver, STREAM_DRAIN_GRACE_MS)),
      ]).then(() => resolve({ exitCode, stdout, stderr }))
    })
  })
