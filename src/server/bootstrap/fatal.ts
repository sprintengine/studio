import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { ServerControlChannel } from './control-channel'
import { SERVER_EXIT } from './envelope'

// What a server under a supervisor does with an error nothing caught: say it
// where a person reads (stderr, which the supervisor keeps in the server log),
// record it in the diagnostics, tell the supervisor, and exit 70 so it is
// started again. Carrying on after an uncaught exception would leave a server
// whose state nobody can vouch for.
//
// An unhandled rejection is logged and not fatal: the desktop has run this same
// code in its own process, where one has never ended the app, and a server that
// restarted on each would lose every chat for a promise someone forgot to catch.

export function installFatalHandlers(
  channel: ServerControlChannel,
  log: (message: string) => void,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let failing = false
  process.on('uncaughtException', (error) => {
    if (failing) return
    failing = true
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    log(`uncaught: ${message}`)
    try {
      channel.send({ t: 'fatal', code: SERVER_EXIT.failed, message: error instanceof Error ? error.message : message })
    } catch {
      // The channel may be what failed.
    }
    // The diagnostic is written, or given a moment, before the process goes.
    const leave = setTimeout(() => exit(SERVER_EXIT.failed), 250)
    void writeDiagnosticLog({
      level: 'error',
      source: 'workspace',
      title: 'Studio server stopped on an error',
      message: error instanceof Error ? error.message : message,
      details: message,
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(leave)
        exit(SERVER_EXIT.failed)
      })
  })
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
  })
}
