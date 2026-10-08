import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { conversationPermissionPresetRefusals } from '../../../../../shared/conversation-harness'
import { CLI_PERMISSION_PRESETS } from '../../../../../shared/cli-permission-preset'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../../../shared/launch-settings'
import type { CliPermissionPreset } from '../../../types/workspace'

// What a chat's model and permission controls may be set to (AgentChatView).

// The model is editable only until the conversation starts: the runtime binds a
// session to one provider/model, so once the user has sent a turn (or a session
// exists) the in-composer picker locks. A replayed transcript counts as a
// started conversation too — after an app restart userTurns/sessionId are empty
// local state, but switching models over restored history would silently start
// a fresh session mid-thread.
export function isConversationModelLocked(
  userTurnCount: number,
  sessionId: string | null,
  hasTranscriptHistory = false,
): boolean {
  return userTurnCount > 0 || sessionId !== null || hasTranscriptHistory
}

/**
 * The presets a chat cannot be switched to, each with the one line its row
 * shows: one its CLI cannot be held to (Cursor never asks before an edit), one
 * the provider does not list, and — on a paired machine built before Manual
 * and Auto came back — the two it would read as No flag.
 */
export function chatPermissionRefusals(input: {
  cli: string | null | undefined
  allowed: readonly CliPermissionPreset[] | undefined
  permissionModes: boolean
  machineName?: string
}): Partial<Record<CliPermissionPreset, string>> | undefined {
  const refusals = conversationPermissionPresetRefusals(input.cli)
  const reasons: Partial<Record<CliPermissionPreset, string>> = {}
  for (const preset of CLI_PERMISSION_PRESETS) {
    const reason =
      refusals[preset] ??
      (!input.permissionModes && (preset === 'manual' || preset === 'auto')
        ? `${input.machineName ?? 'That machine'} needs a newer Studio for this.`
        : input.allowed?.length && !input.allowed.includes(preset)
          ? 'This agent cannot run with this preset.'
          : null)
    if (reason) reasons[preset] = reason
  }
  return Object.keys(reasons).length > 0 ? reasons : undefined
}

// The tool-permission preset the pill reports, in precedence order (1809):
// the live session's own reported preset first — it is what the running child
// applies on its next tool call, and it can disagree with the agent record (an
// optimistic write lost to a reload race, a session started with an explicit
// preset); then the persisted per-agent field every CLI spawn stamps from the
// picker, which is also what the next session starts on; then the app's spawn
// default for an agent record predating the field.
export function resolvePermissionPreset(
  session: Pick<ConversationSessionSummary, 'permissionPreset'> | null,
  agentPreset: CliPermissionPreset | undefined,
): CliPermissionPreset {
  return session?.permissionPreset ?? agentPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET
}

// The CLI's own mode beside that preset, from the same source the preset came
// from: a live session's own report wins whole, so a session that fell back
// to No flag never shows the record's mode beside it.
export function resolvePermissionMode(
  session: Pick<ConversationSessionSummary, 'permissionPreset' | 'permissionMode'> | null,
  agent: { cliPermissionPreset?: CliPermissionPreset; cliPermissionMode?: string } | undefined,
): string | undefined {
  if (session?.permissionPreset) return session.permissionMode
  return agent?.cliPermissionPreset ? agent.cliPermissionMode : undefined
}
