/**
 * Core CLI permission-preset vocabulary: how much an agent may do before it
 * stops to ask. The same four values reach every agent the app starts, a chat
 * or a terminal, and each runtime is told them in its own words.
 *
 * - `bypass` never asks. The CLI's own skip-every-prompt setting (Codex calls
 *   it YOLO).
 * - `auto` edits files inside the workspace and reads without asking, and asks
 *   before anything riskier: shell commands the runtime does not already treat
 *   as safe, network access, and anything outside the workspace. In a chat it
 *   also runs MCP tools unasked, bar the gateway's agent-launching ones
 *   (owner ruling 2026-10-01); a terminal agent's own CLI still asks for them.
 * - `manual` asks before every action that changes something or reaches out:
 *   each edit, command, web request and MCP tool. Read-only lookups inside the
 *   workspace (reading, searching, listing files) run without a card, since a
 *   card for every file read would stop any chat from getting anywhere.
 * - `none` passes no permission setting at all, so the CLI runs on whatever its
 *   own configuration says. That can mean asking, or not.
 */
export type CliPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

/**
 * Four modes again (owner request 2026-09-30). For three days there were only
 * `bypass` and `none`; before that the same four existed, and a chat could not
 * change its mode once it had started. Values written in either period read
 * back as what they were chosen as.
 *
 * Retired spellings map to the mode that kept their promise: `default` (whose
 * label promised "prompts for permissions") to `manual`, `auto_workspace`
 * ("auto-approve workspace edits") to `auto`, `bypass_all` to `bypass`. They
 * are accepted forever on read (persisted settings, saved automations, agent
 * records, third-party plugin manifests, external MCP callers, older paired
 * clients) and never emitted; this is the one place that maps them. Only the
 * absence of a value, or one no version ever wrote, takes the default, which
 * is `bypass`.
 */
export function parseCliPermissionPreset(input: unknown): CliPermissionPreset | null {
  switch (input) {
    case 'none':
    case 'manual':
    case 'auto':
    case 'bypass':
      return input
    case 'bypass_all':
      return 'bypass'
    case 'default':
      return 'manual'
    case 'auto_workspace':
      return 'auto'
    default:
      return null
  }
}

/** A preset from any stored or received value; see `parseCliPermissionPreset`. */
export function normalizeCliPermissionPreset(input: unknown): CliPermissionPreset {
  return parseCliPermissionPreset(input) ?? 'bypass'
}

/**
 * How much each preset lets an agent do without asking, strictest lowest. A
 * `Record` over the union rather than a list, so a preset added to
 * `CliPermissionPreset` does not compile until somebody decides where it sits.
 *
 * The order is what the gateway's launch cap compares: an agent may start
 * another agent only at its own rank or below, so a preset has to be placed by
 * what it permits, not by when it was added. `manual` is the only one the app
 * itself holds to asking. `none` permits nothing the CLI's own configuration
 * does not, which is usually asking before edits and commands but can be more.
 * `auto` lets edits through on top of that, and `bypass` skips every prompt
 * the CLI has.
 */
const CLI_PERMISSION_PRESET_RANK: Record<CliPermissionPreset, number> = {
  manual: 0,
  none: 1,
  auto: 2,
  bypass: 3,
}

/** Whether `candidate` lets an agent do more without asking than `reference` does. */
export function isLooserCliPermissionPreset(candidate: CliPermissionPreset, reference: CliPermissionPreset): boolean {
  return CLI_PERMISSION_PRESET_RANK[candidate] > CLI_PERMISSION_PRESET_RANK[reference]
}

/** Whether no preset lets an agent do more than `preset` already does. */
export function isMostPermissiveCliPermissionPreset(preset: CliPermissionPreset): boolean {
  return (Object.keys(CLI_PERMISSION_PRESET_RANK) as CliPermissionPreset[]).every(
    (other) => !isLooserCliPermissionPreset(other, preset),
  )
}

/** Every preset, strictest first. */
export const CLI_PERMISSION_PRESETS: readonly CliPermissionPreset[] = (
  Object.keys(CLI_PERMISSION_PRESET_RANK) as CliPermissionPreset[]
).sort((a, b) => CLI_PERMISSION_PRESET_RANK[a] - CLI_PERMISSION_PRESET_RANK[b])
