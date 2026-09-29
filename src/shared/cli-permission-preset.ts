/**
 * Core CLI permission-preset vocabulary. The values are what every agent CLI
 * launch understands: `bypass` sends the CLI's own skip-every-prompt flag
 * (Codex calls it YOLO), and `none` sends no permission flag at all, so the
 * CLI's own configuration decides.
 */
export type CliPermissionPreset = 'none' | 'bypass'

/**
 * Two modes, and nothing between them (owner ruling 2026-09-27): every agent
 * spawns with its CLI's bypass flag, and an organization that forbids that
 * picks `none`, which passes no flag and leaves the CLI on its own default.
 * The rungs between — ask before every action, a classifier or a sandbox
 * deciding — were each a different mechanism per CLI, and choosing among them
 * was a decision the CLI's own configuration already makes better.
 *
 * Retired values map to `none`, never to `bypass`. Every one of them was a
 * choice to be asked more often than bypass asks, and a migration that quietly
 * widened what an agent may do without asking would override that choice.
 * `none` is the honest remainder: the CLI does what it is configured to do.
 *
 * Retired spellings are accepted forever on read (persisted settings, saved
 * automations, agent records, third-party plugin manifests, external MCP
 * callers, older paired clients) and never emitted; this is the one place that
 * maps them. Only the absence of a value, or one no version ever wrote, takes
 * the default, which is `bypass`.
 */
export function parseCliPermissionPreset(input: unknown): CliPermissionPreset | null {
  switch (input) {
    case 'none':
    case 'bypass':
      return input
    case 'bypass_all':
      return 'bypass'
    case 'manual':
    case 'auto':
    case 'default':
    case 'auto_workspace':
      return 'none'
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
 * another agent only at its own rank or below, so a preset added between the
 * two has to be placed by what it permits, not by when it was added. `none`
 * permits nothing the CLI's own configuration does not; `bypass` skips every
 * prompt the CLI has.
 */
const CLI_PERMISSION_PRESET_RANK: Record<CliPermissionPreset, number> = {
  none: 0,
  bypass: 1,
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
