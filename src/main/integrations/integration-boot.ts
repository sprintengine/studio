// What the app does with its integrations on every start, before any agent
// launches: write the launcher and point it at this build, list what an
// earlier build wrote (once), and move those entries onto the launcher.

import { dirname, join } from 'node:path'

import { removeHooksDirIfOnlyOurs } from '../agent-state'
import { scanForIntegrations, type ScanHome, type ScanRoot } from './integration-scan'
import { migrateLedgerEntry, removeUnnamedHookScript, type MigrationContext } from './integration-migrate'
import {
  ensureStudioLauncher,
  launcherRefForHome,
  setLocalLauncherWritten,
  type LauncherPointer,
  type LauncherShell,
} from './launcher'
import { ledgerKey, type IntegrationLedger, type IntegrationLedgerEntry } from './ledger'
import type { GitCommandResult } from '../git'

export type PrepareIntegrationsInput = {
  ledger: IntegrationLedger
  /** This machine's home. */
  home: string
  shell: LauncherShell
  pointer: LauncherPointer
  /** The checkouts the app knows (workspace folders), for the one-time scan. */
  listRoots: () => ScanRoot[]
  /** Homes besides this machine's to scan once (none today: a distribution is scanned when it is prepared). */
  extraHomes?: ScanHome[]
  runGit?: (cwd: string, args: string[]) => Promise<GitCommandResult>
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  /**
   * Called once the launcher and its pointer are on disk — the only part an
   * agent launch has to wait for. The scan and the migration after it touch
   * every known checkout and must not hold up the first launch.
   */
  onLauncherReady?: () => void
}

export type PrepareIntegrationsResult = { scanned: number | null; migrated: number; removedScripts: number }

export async function prepareStudioIntegrations(input: PrepareIntegrationsInput): Promise<PrepareIntegrationsResult> {
  let launcher: Awaited<ReturnType<typeof ensureStudioLauncher>>
  try {
    launcher = await ensureStudioLauncher({ nativeHome: input.home, shell: input.shell, pointer: input.pointer })
    setLocalLauncherWritten(true)
  } catch (error) {
    // Writers keep the older form this run rather than name a missing launcher.
    setLocalLauncherWritten(false)
    throw error
  } finally {
    input.onLauncherReady?.()
  }
  await input.ledger.record([
    { kind: 'launcher', path: launcher.dir, marker: 'owned', hostId: 'local', createdFile: true },
  ])

  let scanned: number | null = null
  if ((await input.ledger.scannedAt()) === null) {
    const found = await scanForIntegrations({
      roots: input.listRoots(),
      homes: [{ native: input.home, hostId: 'local' }, ...(input.extraHomes ?? [])],
      ...(input.runGit ? { runGit: input.runGit } : {}),
      ...(input.env ? { env: input.env } : {}),
    })
    await input.ledger.record(found)
    await input.ledger.markScanned()
    scanned = found.length
    input.log?.(`Listed ${found.length} integration entries an earlier build wrote.`)
  }

  const context: MigrationContext = { localLauncher: launcherRefForHome(input.home, input.shell) }
  const result = await migrateHostEntries(input.ledger, 'local', context)
  return { scanned, ...result }
}

/**
 * Move one machine's listed entries onto the launcher, then delete the
 * reporter copies nothing names any more. Also run for a WSL distribution once
 * its helper is up, with that distribution's launcher as the context.
 */
export async function migrateHostEntries(
  ledger: IntegrationLedger,
  hostId: string,
  context: MigrationContext,
): Promise<{ migrated: number; removedScripts: number }> {
  const entries = (await ledger.list()).filter((entry) => entry.hostId === hostId)
  let migrated = 0
  for (const entry of entries) {
    if (await migrateLedgerEntry(entry, context)) migrated += 1
  }
  let removedScripts = 0
  const gone: string[] = []
  for (const script of entries.filter((entry) => entry.kind === 'hook-script')) {
    const namers = namersFor(script, entries)
    if (await removeUnnamedHookScript(script.path, namers).catch(() => false)) {
      removedScripts += 1
      gone.push(ledgerKey(script))
      await removeHooksDirIfOnlyOurs(dirname(script.path)).catch(() => undefined)
    }
  }
  await ledger.forget(gone)
  return { migrated, removedScripts }
}

// The files that could name a reporter copy: every hook or status-line config
// listed under the same checkout (or home) — the directory holding the
// copy's `.sprintengine/hooks`. Matched on the path rather than on the
// recorded repository, which a symlinked or differently-spelled route to the
// same checkout would miss.
//
// Every config file a CLI registration could live in under that directory is
// read too, listed or not: a registration the ledger never saw (a spelling of
// the path the scan did not reach) must still keep the copy it runs.
const KNOWN_REGISTRATION_FILES: ReadonlyArray<readonly string[]> = [
  ['.claude', 'settings.local.json'],
  ['.claude', 'settings.json'],
  ['.codex', 'config.toml'],
  ['.cursor', 'hooks.json'],
  ['.grok', 'hooks', 'sprintengine-agent-state.json'],
  ['.kimi-code', 'config.toml'],
]

function namersFor(script: IntegrationLedgerEntry, entries: readonly IntegrationLedgerEntry[]): string[] {
  const configKinds = new Set(['agent-state-hooks', 'status-line', 'knowledge-activity-hook'])
  const owner = dirname(dirname(dirname(script.path)))
  const under = (path: string) => path.startsWith(`${owner}/`) || path.startsWith(`${owner}\\`)
  return [
    ...entries.filter((entry) => configKinds.has(entry.kind) && under(entry.path)).map((entry) => entry.path),
    ...KNOWN_REGISTRATION_FILES.map((parts) => join(owner, ...parts)),
  ].filter((path, index, all) => all.indexOf(path) === index)
}

/** The ledger's mirror inside a distribution, as this process opens it. */
export function wslLedgerMirrorPath(nativeHome: string): string {
  return join(nativeHome, '.sprintengine', 'integration-ledger.json')
}
