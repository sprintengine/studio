// Part of the IPC contract: agent CLI version advisories.
// ../electron-api.ts re-exports everything here.

import type { ExecutionHostId } from '../execution-host'
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
  // The machine the installed version was found on: this one (`local`) or a
  // WSL distribution. The same CLI can be current on one and behind on another.
  hostId: ExecutionHostId
  status: CliVersionAdvisoryStatus
  currentVersion: string | null
  latestVersion: string | null
  updateCommand: CliUpdateCommand | null
  checkedAt: string
}

export type CliVersionAdvisoryMap = Partial<Record<AgentCli, CliVersionAdvisory>>

// One map per machine main checks: this one, and each WSL distribution turned
// on in Settings ▸ Machines. A machine absent here has not been detected yet.
export type CliVersionHostAdvisories = Partial<Record<ExecutionHostId, CliVersionAdvisoryMap>>

// Main reads each machine's CLI commands from its own launch settings, so the
// renderer names no runtimes.
export type CliVersionAdvisoriesInput = {
  // Bypass the hour-long registry cache, and answer even while the Settings
  // switch has version checks off.
  force?: boolean
  // Settings' Re-check: detect every CLI on every machine again first. Without
  // it the answer compares the installed versions detection last found.
  detect?: boolean
}

export type CliVersionAdvisoriesResult =
  | {
      ok: true
      advisories: CliVersionHostAdvisories
      checkedAt: string
      // Outdated CLIs this install has not been told about at this version
      // yet: the toast fires once per (machine, cli, latestVersion). Main
      // records what it has announced, so a restart does not repeat them.
      newlyOutdated?: CliVersionAdvisory[]
    }
  | { ok: false; message: string }
