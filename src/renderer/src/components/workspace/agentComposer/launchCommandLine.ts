// The receipt line's data: what the spawn about to happen will run.
//
// The renderer cannot compute this. A plugin's argv lives in its manifest and
// main deliberately withholds it from the renderer catalog, so this asks main to
// render the line through `renderAgentLaunchArgv` — the spawn's own function.
// The whole value of the line is that it is true; a hand-written `--permission-
// mode` preview would be a promise the launch path is free to break.
//
// The prompt is never in it: it is on screen a line above, and rendering it
// would re-render the receipt on every keystroke.

import type {
  AgentCli,
  AgentLaunchPreview,
  AgentLaunchPreviewInput,
  CliRuntimeSettings,
  CliPermissionPreset,
} from '../../../../../shared/electron-api'

export type LaunchCommandLineInput = {
  cli: AgentCli | null
  model?: string
  reasoning?: string
  permissionPreset: CliPermissionPreset
  /** The CLI's own mode at that preset, when it is not the preset's own. */
  permissionMode?: string
  runtime?: Partial<CliRuntimeSettings>
}

export type LaunchCommandLineState =
  { status: 'idle' } | { status: 'ready'; preview: AgentLaunchPreview } | { status: 'error'; message: string }

/**
 * A stable key for one set of launch arguments. The surface re-asks main only
 * when this changes, so typing a prompt costs nothing and flipping a chip costs
 * one IPC round trip.
 */
export function launchCommandLineKey(input: LaunchCommandLineInput): string {
  if (!input.cli) return ''
  return [
    input.cli,
    input.model ?? '',
    input.reasoning ?? '',
    input.permissionPreset,
    input.permissionMode ?? '',
    input.runtime?.command ?? '',
    input.runtime?.hostId ?? '',
  ].join('\0')
}

/** The IPC payload for a set of arguments, or null when no CLI is selected. */
export function launchPreviewRequest(input: LaunchCommandLineInput): AgentLaunchPreviewInput | null {
  if (!input.cli) return null
  const runtime = input.runtime
  return {
    cli: input.cli,
    ...(input.model ? { cliModel: input.model } : {}),
    ...(input.reasoning ? { cliReasoning: input.reasoning } : {}),
    cliPermissionPreset: input.permissionPreset,
    ...(input.permissionMode ? { cliPermissionMode: input.permissionMode } : {}),
    // Only forward a runtime override that actually overrides something: an
    // empty command would otherwise render as a blank binary in the receipt.
    ...(runtime?.command?.trim()
      ? { cliRuntime: { command: runtime.command, ...(runtime.hostId ? { hostId: runtime.hostId } : {}) } }
      : {}),
  }
}
