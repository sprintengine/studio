import {
  AGENT_BACKED_ACTION_KINDS,
  AUTOMATION_DEFAULT_PERMISSION_PRESET,
  type AutomationDefinition,
  type AutomationsInstanceEntry,
} from '../../../../../../shared/automations/contracts'
import { parseCliPermissionPreset, type CliPermissionPreset } from '../../../../../../shared/cli-permission-preset'
import { isRecord } from '../../../../../../shared/records'

// What the approval review states about an automation, read the way the run
// will read it: an unset preset is the default the executor falls back to
// (bypass), an unset `runInWorktree` is a worktree, a legacy preset spelling is
// what it maps to. Pure, so the facts a person is asked to approve are pinned
// by tests rather than by whatever the card happens to render.

export type ApprovalReviewFacts = {
  /** The action launches a CLI agent. Only then do the agent facts apply. */
  agentBacked: boolean
  /** The CLI it names, or null when it falls back to the one last used. */
  cli: string | null
  model: string | null
  /** The preset it will actually run on, or null for an action with no agent. */
  permission: CliPermissionPreset | null
  /** True when the preset is the default because the file names none. */
  permissionIsDefault: boolean
  /** Whether the run gets its own worktree; null for an action with no agent. */
  runsInWorktree: boolean | null
  /** A folder the action points the agent at instead of the project root. */
  folderPath: string | null
  /**
   * The action's whole config, for a kind this screen does not know how to
   * describe (a module's). Shown verbatim: an approval of what could not be
   * read is not an approval.
   */
  rawConfig: string | null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function approvalReviewFacts(definition: AutomationDefinition): ApprovalReviewFacts {
  const config = isRecord(definition.action.config) ? definition.action.config : {}
  const agentBacked = AGENT_BACKED_ACTION_KINDS.includes(definition.action.kind)
  const knownKind = agentBacked || definition.action.kind === 'run-command'
  const named = optionalString(config.permissionPreset)
  // A spelling no version wrote fails the run's own parse; showing the default
  // for it would claim a preset the run will never get.
  const parsed = named === null ? null : parseCliPermissionPreset(named)
  return {
    agentBacked,
    cli: agentBacked ? optionalString(config.cli) : null,
    model: agentBacked ? optionalString(config.cliModel) : null,
    permission: agentBacked ? (named === null ? AUTOMATION_DEFAULT_PERMISSION_PRESET : parsed) : null,
    permissionIsDefault: agentBacked && named === null,
    runsInWorktree: agentBacked ? definition.runInWorktree !== false : null,
    folderPath: optionalString(config.folderPath),
    rawConfig: knownKind ? null : JSON.stringify(definition.action.config ?? null, null, 2),
  }
}

/** The review's two headlines: why it is waiting, and what allowing means. */
export function approvalReviewCopy(reason: 'unreviewed' | 'changed'): { title: string; hint: string } {
  return reason === 'changed'
    ? {
        title: 'This automation changed since you allowed it',
        hint: 'Its file was edited outside the app — by a pull, or by something working in the project. It will not run again until you allow what it says now.',
      }
    : {
        title: 'This automation was not made in this app on this machine',
        hint: 'It came with the project, or something wrote it there. Nothing in it runs — not on its schedule, not from a webhook, not with Run now — until you read what it does and allow it.',
      }
}

/** Every automation in `workspaceRoot` that is waiting, in the order listed. */
export function waitingInProject(
  entries: readonly AutomationsInstanceEntry[],
  workspaceRoot: string,
): AutomationsInstanceEntry[] {
  return entries.filter((entry) => entry.workspaceRoot === workspaceRoot && entry.approval?.state === 'needs-approval')
}
