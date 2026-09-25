// The shape of "remove Studio's integrations", shared by the Settings page that
// confirms it and the main process that does it.

/** How the confirmation groups what will be removed. */
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

export const INTEGRATION_REMOVAL_GROUP_ORDER: readonly IntegrationRemovalGroup[] = [
  'repositories',
  'user-config',
  'tailnet',
  'worktree-locks',
  'protocol',
  'wsl',
  'launcher',
]

export const INTEGRATION_REMOVAL_GROUP_LABEL: Record<IntegrationRemovalGroup, string> = {
  repositories: 'CLI configs and hooks in your repositories',
  'user-config': 'User-level CLI configuration',
  tailnet: 'Ports shared on your tailnet',
  'worktree-locks': 'Worktree locks',
  protocol: 'The sprintengine:// link handler',
  wsl: 'WSL distributions',
  launcher: 'The Studio launcher',
}

export type IntegrationRemovalItem = {
  /** Stable for one plan: the ledger key. */
  id: string
  group: IntegrationRemovalGroup
  /** What it is, in a sentence fragment ("Codex hooks", "MCP server entry"). */
  label: string
  /** Where: a file, a directory, a port, a registry key. */
  path: string
  hostId: string
  repo?: string
}

export type IntegrationRemovalPlan = {
  items: IntegrationRemovalItem[]
  /** Worktrees this profile locked, offered for removal too (never removed unless asked). */
  lockedWorktrees: Array<{ path: string; repo: string }>
  /** What "Also delete Studio's data" deletes. */
  appDataPaths: string[]
}

export type IntegrationRemovalOptions = {
  /** Also remove the locked worktrees (only ones with no uncommitted changes). */
  removeWorktrees?: boolean
  /** Also delete the app's own data once it quits. */
  deleteAppData?: boolean
  /** Only this machine's entries (`wsl:<distro>`), for removing one distribution. */
  hostId?: string
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
  /** The app's data will be deleted once it quits. */
  appDataScheduled: boolean
}

/** The command-line flag that runs the removal with no window (`remove-integrations-cli.ts`). */
export const REMOVE_INTEGRATIONS_FLAG = '--remove-integrations'

export const INTEGRATIONS_CHANNELS = {
  plan: 'integrations:plan',
  remove: 'integrations:remove',
  /** Quit after a removal, so nothing writes an integration back before the uninstall. */
  quit: 'integrations:quit',
} as const

export function summarizeRemoval(
  outcomes: IntegrationRemovalOutcome[],
  appDataScheduled: boolean,
): IntegrationRemovalReport {
  return {
    outcomes,
    removed: outcomes.filter((outcome) => outcome.status === 'removed').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
    appDataScheduled,
  }
}

/** The headless run's exit code: 0 nothing failed, 2 something failed, 3 it could not run. */
export function removalExitCode(report: IntegrationRemovalReport | null): number {
  if (!report) return 3
  return report.failed > 0 ? 2 : 0
}
