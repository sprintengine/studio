import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { readStudioEnv } from '../shared/studio-env'
import { writeDiagnosticLog } from '../main/diagnostics-service'
import { defaultServerLocations } from './platform/studio-paths'
import {
  EXIT_FAILED,
  EXIT_USAGE,
  startStudioServer,
  StudioServerStartError,
  type StudioServer,
  type StudioServerOptions,
} from './studio-server'

// `studio-server`: the Studio core under plain Node.
//
//   node out/server/server.cjs [serve] [--data-dir <dir>] [--logs-dir <dir>]
//        [--app-root <dir>] [--resources-dir <dir> --packaged]
//        [--share-desktop-data-dir] [--stdio]
//   node out/server/server.cjs --version
//
// Once its gateway is listening it prints one JSON line on stdout,
// `{"ready":{…}}`, and keeps stdout for such lines; everything said to a person
// goes to stderr. With `--stdio` its parent drives it over stdin instead of a
// terminal: `{"t":"shutdown"}` stops it, and stdin closing (the parent gone)
// stops it too. SIGINT and SIGTERM stop it gracefully; a second one does not
// wait. The exit codes say whether trying again can help (studio-server.ts).
//
// Nothing starts this yet: the desktop still runs the same core in its own
// process. It is how the core is shown to run without Electron, and what a
// later phase's desktop, WSL distribution or SSH host starts.

// The same server as a library, for a process that embeds it rather than
// starting it from a shell: a later phase's bootstrap, and the smoke test,
// which requires this bundle and drives a chat on the core it returns.
export { startStudioServer, StudioServerStartError } from './studio-server'
export type { StudioServer, StudioServerOptions, StudioServerReady } from './studio-server'

/** Baked in by scripts/build-server.mjs. */
declare const __STUDIO_SERVER_BUILD__: { version: string; commit: string | null; builtAt: string } | undefined

// How long a graceful stop may take before the process leaves anyway: the
// chats' children are told to stop and the registry is flushed in that time.
const SHUTDOWN_BUDGET_MS = 10_000

const USAGE = `Usage: studio-server [serve] [options]

  --data-dir <dir>           Where the server keeps its data (default: the XDG data directory,
                             or SPRINTENGINE_USER_DATA_DIR)
  --logs-dir <dir>           Where it writes diagnostics (default: logs/ in a data directory given
                             by flag or SPRINTENGINE_USER_DATA_DIR, else the XDG state directory)
  --app-root <dir>           The checkout or install the server runs from (default: beside the bundle)
  --resources-dir <dir>      An installed build's resources directory
  --packaged                 This is an installed build, not a source checkout
  --share-desktop-data-dir   Run against the desktop app's data directory, with saved keys off
  --stdio                    Driven by a parent over stdin: stop on {"t":"shutdown"} or when stdin closes
  --version                  Print the version and exit
`

function bundledBuild(): { version: string; commit: string | null; builtAt: string } | null {
  return typeof __STUDIO_SERVER_BUILD__ === 'undefined' ? null : __STUDIO_SERVER_BUILD__
}

/** The checkout this bundle was built in: `out/server/` sits two levels below it. */
function defaultAppRoot(): string | null {
  const candidate = resolve(__dirname, '..', '..')
  return existsSync(join(candidate, 'resources', 'automation')) ? candidate : null
}

function versionFrom(appRoot: string | null): string {
  const baked = bundledBuild()?.version
  if (baked) return baked
  try {
    const manifest = JSON.parse(readFileSync(join(appRoot ?? '', 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string') return manifest.version
  } catch {
    // Not a checkout.
  }
  return '0.0.0'
}

type Command = { kind: 'version' } | { kind: 'help' } | { kind: 'serve'; options: StudioServerOptions; stdio: boolean }

export function parseServerArgs(argv: string[], env = process.env): Command {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'data-dir': { type: 'string' },
      'logs-dir': { type: 'string' },
      'app-root': { type: 'string' },
      'resources-dir': { type: 'string' },
      packaged: { type: 'boolean' },
      'share-desktop-data-dir': { type: 'boolean' },
      stdio: { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.version) return { kind: 'version' }
  if (values.help) return { kind: 'help' }
  const [command = 'serve', ...rest] = positionals
  if (command !== 'serve' || rest.length > 0) throw new Error(`Unknown command: ${positionals.join(' ')}`)
  if (values.packaged && !values['resources-dir']) throw new Error('--packaged needs --resources-dir.')

  const defaults = defaultServerLocations({ env })
  const profile = readStudioEnv('SPRINTENGINE_USER_DATA_DIR', env)?.trim()
  const appRoot = values['app-root'] ? resolve(values['app-root']) : defaultAppRoot()
  const chosenDataDir = values['data-dir'] ?? (profile || null)
  // A server pointed at a directory keeps everything in it; one on the default
  // locations logs where XDG puts state.
  const dataDir = resolve(chosenDataDir ?? defaults.dataDir)
  return {
    kind: 'serve',
    stdio: values.stdio === true,
    options: {
      dataDir,
      logsDir: resolve(values['logs-dir'] ?? (chosenDataDir ? join(dataDir, 'logs') : defaults.logsDir)),
      version: versionFrom(appRoot),
      packaged: values.packaged === true,
      resourcesDir: values['resources-dir'] ? resolve(values['resources-dir']) : null,
      appRoot,
      shareDesktopDataDir: values['share-desktop-data-dir'] === true,
    },
  }
}

function say(message: string): void {
  process.stderr.write(`[studio-server] ${message}\n`)
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

async function main(argv: string[]): Promise<number> {
  let command: Command
  try {
    command = parseServerArgs(argv)
  } catch (error) {
    say(error instanceof Error ? error.message : String(error))
    process.stderr.write(USAGE)
    return EXIT_USAGE
  }
  if (command.kind === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command.kind === 'version') {
    process.stdout.write(`${versionFrom(defaultAppRoot())}\n`)
    return 0
  }

  let server: StudioServer
  try {
    server = await startStudioServer(command.options)
  } catch (error) {
    const code = error instanceof StudioServerStartError ? error.exitCode : EXIT_FAILED
    const message = error instanceof Error ? error.message : String(error)
    say(message)
    emit({ fatal: { code, message } })
    return code
  }
  const { ready } = server
  emit({ ready })
  say(
    `ready: ${ready.dataDir}, gateway ${ready.gatewaySocket ?? 'not running'}` +
      (ready.secrets ? '' : ', saved keys off (desktop data directory)'),
  )

  return new Promise<number>((settle) => {
    let stopping = false
    const stop = (reason: string, code = 0): void => {
      if (stopping) return
      stopping = true
      say(`stopping (${reason})`)
      const budget = setTimeout(() => {
        say(`stop took longer than ${SHUTDOWN_BUDGET_MS / 1000}s; leaving anyway`)
        server.core.dataDirLock?.release()
        settle(code)
      }, SHUTDOWN_BUDGET_MS)
      budget.unref()
      void server.stop().then(
        () => {
          clearTimeout(budget)
          settle(code)
        },
        (error: unknown) => {
          clearTimeout(budget)
          say(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
          settle(EXIT_FAILED)
        },
      )
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        if (stopping) {
          // A second signal: the person does not want to wait.
          server.core.dataDirLock?.release()
          process.exit(EXIT_FAILED)
        }
        stop(signal)
      })
    }
    process.on('uncaughtException', (error) => {
      say(`uncaught: ${error.stack ?? error.message}`)
      void writeDiagnosticLog({ level: 'error', source: 'workspace', title: 'Studio server', message: error.message })
      stop('uncaught exception', EXIT_FAILED)
    })
    process.on('unhandledRejection', (reason) => {
      // Logged, not fatal: the desktop runs the same code, where an unhandled
      // rejection has never ended the process.
      say(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    })

    if (command.stdio) {
      const lines = createInterface({ input: process.stdin })
      lines.on('line', (line) => {
        let message: { t?: unknown }
        try {
          message = JSON.parse(line) as { t?: unknown }
        } catch {
          say('ignored a stdin line that is not JSON')
          return
        }
        if (message.t === 'shutdown') stop('asked to')
      })
      lines.on('close', () => stop('stdin closed'))
    }
  })
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code))
}
