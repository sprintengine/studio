// The shape of a report from "remove Studio's integrations": what the app
// takes out when it quits, and what `--remove-integrations` prints.

/** Where a removed entry was. */
export type IntegrationRemovalGroup =
  /** Hooks, MCP entries, settings keys, plugin and skill copies inside repositories. */
  | 'repositories'
  /** Entries in a CLI's user-level configuration (Kimi Code's hooks, Claude Code's marketplace list). */
  | 'user-config'
  /** `tailscale serve` mappings this app published. */
  | 'tailnet'
  /** `git worktree lock`s this profile placed. */
  | 'worktree-locks'
  /** The `sprintengine://` link handler. */
  | 'protocol'
  /** Everything inside a WSL distribution, including the app's files there. */
  | 'wsl'
  /** The Studio launcher every entry above runs, removed last. */
  | 'launcher'

export type IntegrationRemovalItem = {
  /** The ledger key. */
  id: string
  group: IntegrationRemovalGroup
  /** What it is, in a sentence fragment ("Codex hooks", "MCP server entry"). */
  label: string
  /** Where: a file, a directory, a port, a registry key. */
  path: string
  hostId: string
  repo?: string
}

export type IntegrationRemovalStatus = 'removed' | 'skipped' | 'failed'

export type IntegrationRemovalOutcome = {
  id: string
  group: IntegrationRemovalGroup
  label: string
  path: string
  status: IntegrationRemovalStatus
  /** Why it was skipped or failed; absent when removed. */
  reason?: string
}

export type IntegrationRemovalReport = {
  outcomes: IntegrationRemovalOutcome[]
  removed: number
  skipped: number
  failed: number
}

/** The command-line flag that runs the removal with no window (`remove-integrations-cli.ts`). */
export const REMOVE_INTEGRATIONS_FLAG = '--remove-integrations'

export function summarizeRemoval(outcomes: IntegrationRemovalOutcome[]): IntegrationRemovalReport {
  return {
    outcomes,
    removed: outcomes.filter((outcome) => outcome.status === 'removed').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
  }
}

/** The headless run's exit code: 0 nothing failed, 2 something failed, 3 it could not run. */
export function removalExitCode(report: IntegrationRemovalReport | null): number {
  if (!report) return 3
  return report.failed > 0 ? 2 : 0
}
