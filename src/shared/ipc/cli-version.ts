// Part of the IPC contract: agent CLI version advisories.
// ../electron-api.ts re-exports everything here.

import type { CliRuntimeSettings } from './agent-runtime'
import type { AgentCli } from './conversations'

// Whether an installed agent CLI is behind the newest version its package
// registry publishes. `unknown` covers a
// CLI with no `package` block, an unparsable version, or a registry that did
// not answer; it is never rendered as "up to date". `updateCommand` is what
// the Update button will run, chosen in main from the manifest and where the
// binary lives; the renderer shows it and never composes one.
export type CliVersionAdvisoryStatus = 'current' | 'behind_latest' | 'unknown'

export type CliUpdateCommand = {
  kind: 'cli-updater' | 'brew' | 'npm' | 'install-method'
  command: string
}

export type CliVersionAdvisory = {
  cli: AgentCli
  status: CliVersionAdvisoryStatus
  currentVersion: string | null
  latestVersion: string | null
  updateCommand: CliUpdateCommand | null
  checkedAt: string
}

export type CliVersionAdvisoryMap = Partial<Record<AgentCli, CliVersionAdvisory>>

export type CliVersionAdvisoriesInput = {
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  // Bypass the hour-long registry cache (Settings "Re-check").
  force?: boolean
}

export type CliVersionAdvisoriesResult =
  | {
      ok: true
      advisories: CliVersionAdvisoryMap
      checkedAt: string
      // Outdated CLIs this install has not been told about at this version
      // yet: the toast fires once per (cli, latestVersion). Main records the
      // pairs it has announced, so a restart does not repeat them.
      newlyOutdated?: CliVersionAdvisory[]
    }
  | { ok: false; message: string }
