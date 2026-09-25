// `SprintEngine Studio --remove-integrations`: the same removal Settings runs,
// with no window, for the Windows uninstaller (and anyone scripting an
// uninstall elsewhere). Prints one line per entry and a summary, appends the
// same to `integration-removal.log` in the profile, and exits:
//
//   0  everything listed was removed, or was already gone
//   2  something could not be removed (the rest was)
//   3  the removal could not run at all, or ran past its time limit
//   4  Studio is running; quit it first (decided by the entry, `index.ts`)
//
// Loaded by the entry instead of the app proper, so none of the app's services
// start — nothing writes an integration back while this takes them out.

import type { App } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { removalExitCode, type IntegrationRemovalReport } from '../../shared/integration-removal'
import { readServedPortsOrNull, unshareServePort } from '../automation/tailnet/tailscale-serve'
import { createIntegrationLedger, hostIdForPath, INTEGRATION_LEDGER_FILE } from './ledger'
import { removeIntegrations, type IntegrationRemovalDeps } from './remove-integrations'
import { readRegistryRoots, wslHomesFromLedger } from './removal-sources'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 10 * 60_000

/** `--timeout=<ms>`, bounded; the uninstaller passes one. */
export function headlessTimeoutMs(argv: readonly string[]): number {
  const raw = argv.find((arg) => arg.startsWith('--timeout='))?.slice('--timeout='.length)
  const value = Number(raw)
  return Number.isFinite(value) && value >= 1_000 ? Math.min(value, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

/** One tab-separated line per entry, then a summary line. */
export function formatRemovalReport(report: IntegrationRemovalReport): string[] {
  const lines = report.outcomes.map(
    (outcome) => `${outcome.status}\t${outcome.label}\t${outcome.path}${outcome.reason ? `\t${outcome.reason}` : ''}`,
  )
  lines.push(`summary\tremoved=${report.removed} skipped=${report.skipped} failed=${report.failed}`)
  return lines
}

export type RemovalCommandInput = {
  userDataDir: string
  home: string
  /** Everything the removal needs from the machine that is not a file; tests pass stand-ins. */
  deps?: Partial<Omit<IntegrationRemovalDeps, 'ledger'>>
  write?: (text: string) => void
}

/**
 * The command's work, apart from Electron: remove, report, log. Returns the
 * exit code. Never throws.
 */
export async function runRemovalCommand(input: RemovalCommandInput): Promise<number> {
  const write = input.write ?? ((text: string) => process.stdout.write(text))
  try {
    const ledger = createIntegrationLedger({ path: join(input.userDataDir, INTEGRATION_LEDGER_FILE) })
    const entries = await ledger.list()
    const report = await removeIntegrations({
      ledger,
      listRoots: () =>
        [
          ...new Set([
            ...readRegistryRoots(input.userDataDir),
            ...entries.flatMap((entry) => (entry.repo ? [entry.repo] : [])),
          ]),
        ].map((path) => ({ path, hostId: hostIdForPath(path) })),
      listHomes: async () => [{ native: input.home, hostId: 'local' }, ...wslHomesFromLedger(await ledger.list())],
      ...input.deps,
    })
    const lines = formatRemovalReport(report)
    write(`${lines.join('\n')}\n`)
    const log = join(input.userDataDir, 'integration-removal.log')
    await mkdir(dirname(log), { recursive: true }).catch(() => undefined)
    await appendFile(log, `${new Date().toISOString()}\n${lines.join('\n')}\n`).catch(() => undefined)
    return removalExitCode(report)
  } catch (error) {
    write(`failed\tremoval\t${error instanceof Error ? error.message : String(error)}\n`)
    return removalExitCode(null)
  }
}

/** The Electron side: no window, a hard time limit, and the exit code. */
export async function runHeadlessRemoval(app: App, argv: readonly string[] = process.argv): Promise<void> {
  // Whatever happens below, the process ends in time: an uninstaller is
  // waiting, and with `/S` nobody is there to answer Electron's crash dialog.
  const fail = (): void => app.exit(removalExitCode(null))
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)
  const timer = setTimeout(() => {
    process.stdout.write('failed\ttime limit\tThe removal ran past its time limit.\n')
    fail()
  }, headlessTimeoutMs(argv))
  // No window, so no GPU process: nothing started from the install folder is
  // left holding its files when the uninstaller goes on to delete them. And no
  // wait for `ready`, which nothing here needs and a display-less Linux never
  // reaches.
  app.disableHardwareAcceleration()
  app.dock?.hide()
  const code = await runRemovalCommand({
    userDataDir: app.getPath('userData'),
    home: homedir(),
    deps: {
      // The first start of a build that keeps a ledger scanned already, and
      // an uninstall has a time limit to keep.
      scan: false,
      readServedPorts: () => readServedPortsOrNull(),
      unsharePort: (servePort) => unshareServePort({ servePort }),
      // A packaged build registered itself without arguments; the uninstaller
      // only ever runs a packaged one.
      removeProtocolClient: (scheme) => app.removeAsDefaultProtocolClient(scheme),
    },
  })
  clearTimeout(timer)
  app.exit(code)
}
