import type { ForkOptions, MessagePortMain, UtilityProcess } from 'electron'

import type { ServerLog } from './server-log'
import type { ServerChild, ServerExit } from './supervisor'

// The desktop's Studio server is a utility process (phase 6 spec, decision
// D1): it dies with the app even when the app is force-quit, it can take a
// window's message port, and the agents it spawns never inherit
// `ELECTRON_RUN_AS_NODE`. On macOS it runs as the signed Helper, under the
// Helper's entitlements; on Windows and Linux it is the app's own executable.
//
// Its stdout and stderr go to the server log line by line. No heap cap is
// passed (decision R06): Node's own limit applies, and a crash restarts it.

export type UtilityForker = { fork(modulePath: string, args?: string[], options?: ForkOptions): UtilityProcess }

export type UtilityServerOptions = {
  utilityProcess: UtilityForker
  /** The bundled server entry (`out/main/studio-server.js`). */
  modulePath: string
  log: ServerLog
  env?: NodeJS.ProcessEnv
  /** Defaults to process.kill, so a hung server is ended with SIGKILL rather than asked. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
}

/** What `getAppMetrics` lists the server as. */
export const SERVER_SERVICE_NAME = 'Studio Server'

export function forkUtilityServer(options: UtilityServerOptions): ServerChild {
  const child = options.utilityProcess.fork(options.modulePath, [], {
    serviceName: SERVER_SERVICE_NAME,
    stdio: 'pipe',
    ...(options.env ? { env: options.env } : {}),
  })
  options.log.note(`forked ${options.modulePath}`)
  child.stdout?.on('data', (chunk: Buffer) => options.log.write('out', chunk))
  child.stderr?.on('data', (chunk: Buffer) => options.log.write('err', chunk))
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal))
  const platform = options.platform ?? process.platform
  return {
    get pid() {
      return child.pid ?? null
    },
    postMessage(message, transfer) {
      child.postMessage(message, (transfer ?? []) as MessagePortMain[])
    },
    onMessage(listener) {
      child.on('message', (message: unknown) => listener(message))
    },
    onExit(listener) {
      child.once('exit', (code: number) => {
        const exit: ServerExit = { code: typeof code === 'number' ? code : null, signal: null }
        options.log.note(`exited with code ${exit.code ?? 'none'}`)
        listener(exit)
      })
    },
    kill() {
      const pid = child.pid
      options.log.note(`killing pid ${pid ?? 'unknown'}`)
      // A hung event loop does not run a SIGTERM handler: SIGKILL ends it
      // whatever it is doing. Windows has one way, which `kill` takes.
      if (platform !== 'win32' && typeof pid === 'number') {
        try {
          killProcess(pid, 'SIGKILL')
          return
        } catch {
          // Gone already, or not ours to signal: fall through.
        }
      }
      child.kill()
    },
  }
}
