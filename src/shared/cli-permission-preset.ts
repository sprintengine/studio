/**
 * Core CLI permission-preset vocabulary. The values are what every agent CLI
 * launch understands; Sprint Engine automation types re-export the same union
 * under the historical `CliPermissionPreset` name.
 */
export type CliPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

/**
 * Spellings written before MC-2210. Accepted forever on read (persisted
 * settings, saved automations, third-party plugin manifests, external MCP
 * callers) and never emitted. `normalizeCliPermissionPreset` is the one place
 * that maps them.
 */
export type LegacyCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

/**
 * Legacy `default` maps to `manual`, NOT to `none`, even though `none` is what
 * reproduces its exact argv. Two reasons, both found the hard way:
 *
 *  1. `default` was doing double duty — a real preset AND the "this run has no
 *     local override" sentinel that persistence and run settings test against.
 *     Mapping it to `none` makes it a third real value and the sentinel stops
 *     matching, so a factory-default run silently stops inheriting the app
 *     default (caught by the v61 persistence migration test).
 *  2. It is the conservative direction. `none` sends no flag, and no flag now
 *     means whatever the CLI defaults to — auto mode on Claude Code 2.1.228+
 *     with a Pro/Max/Team plan. `manual` is the value that still means what
 *     the old preset's label promised: ask before every action.
 *
 * The cost is that a saved `default` now sends `--permission-mode default`
 * where it used to send nothing. Nobody chose that distinction: the old UI
 * offered one option labelled "Default (Claude prompts for permissions)", and
 * `manual` is the preset that keeps that promise.
 *
 * Anything unrecognised floors to `manual` for the same reason.
 */
export function normalizeCliPermissionPreset(
  input: CliPermissionPreset | LegacyCliPermissionPreset | null | undefined,
): CliPermissionPreset {
  switch (input) {
    case 'none':
    case 'manual':
    case 'auto':
    case 'bypass':
      return input
    case 'default':
      return 'manual'
    case 'auto_workspace':
      return 'auto'
    case 'bypass_all':
      return 'bypass'
    default:
      return 'manual'
  }
}
