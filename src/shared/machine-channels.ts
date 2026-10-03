// The `window.api` channels a workspace on another machine (an SSH machine,
// phase 8) is answered on by that machine's Studio server rather than this
// computer: its files and its git, read (and staged and committed) there
// through the server's raw access to its machine. The desktop builds every
// view; the server only reads and runs git. A channel not listed here is
// refused for such a workspace in words, never answered from this computer's
// disk.

export const MACHINE_CHANNELS = [
  // Files: the explorer, the editor's and the previews' reads, @-mention search.
  'fs:readdir',
  'fs:readfile',
  'fs:read-image-data-url',
  'fs:path-exists',
  'fs:stat',
  'fs:check-workspace-folder',
  'fs:search-files',
  // Git, read: status, diffs, history.
  'git:get-repo-root',
  'git:get-status',
  'git:check-ignored',
  'git:get-file-base',
  'git:get-file-at-stage',
  'git:get-file-at-rev',
  'git:get-file-hunks',
  'git:get-workspace-change-summary',
  'git:get-branch-steps',
  'git:get-branch-step-diff',
  'git:get-branches',
  'git:get-commit-graph',
  'git:get-repository-identity',
  // Git, written: staging and committing in the Git pane.
  'git:stage',
  'git:unstage',
  'git:stage-hunk',
  'git:unstage-hunk',
  'git:commit',
] as const

export type MachineChannel = (typeof MACHINE_CHANNELS)[number]

const MACHINE_CHANNEL_SET: ReadonlySet<string> = new Set(MACHINE_CHANNELS)

export function isMachineChannel(channel: string): channel is MachineChannel {
  return MACHINE_CHANNEL_SET.has(channel)
}

/**
 * Channels that need nothing from the machine for such a workspace: a watch
 * (the views refresh by asking again) answers that there is none.
 */
export const MACHINE_QUIET_CHANNELS: Readonly<Record<string, unknown>> = {
  'fs:watch-start': null,
  'fs:watch-stop': undefined,
  'git:checkout-watch-retain': null,
  'git:checkout-watch-release': undefined,
}

/** What a window is told for anything else asked about such a workspace. */
export function notOnMachineYet(channel: string): string {
  return `Not available for SSH machines yet (Studio's ${channel} channel).`
}
