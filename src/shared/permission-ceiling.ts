import {
  isLooserCliPermissionPreset,
  isMostPermissiveCliPermissionPreset,
  type CliPermissionPreset,
} from './cli-permission-preset'

// A permission ceiling: the loosest preset an agent may run on when someone
// other than the person starts or drives it. A module has one (`auto`, or
// `bypass` with `conversation:bypass`), an agent calling a module's tool has
// one (its own preset), and a local app paired with Studio has one (chosen
// when it was paired). The two rules below are the whole of what a ceiling
// means, so every caller that has one applies them the same way.

/**
 * The preset an agent started under `ceiling` runs on: the one asked for,
 * lowered to the ceiling when looser, and pinned to the ceiling when none was
 * asked for — the launch default could be looser than the ceiling. Lowered
 * rather than refused: whoever asked cannot always know the ceiling it is
 * under. No ceiling (null) leaves the request as it is.
 */
export function clampPresetToCeiling(
  requested: CliPermissionPreset | undefined,
  ceiling: CliPermissionPreset | null,
): CliPermissionPreset | undefined {
  if (ceiling === null) return requested
  if (requested === undefined) return isMostPermissiveCliPermissionPreset(ceiling) ? undefined : ceiling
  return isLooserCliPermissionPreset(requested, ceiling) ? ceiling : requested
}

/**
 * Whether tools may be named that a chat uses without asking. Allowing a tool
 * unasked is as loose as `bypass` for that tool, so only a caller whose own
 * ceiling is the loosest may name them, and not while it is serving a caller
 * capped below that.
 */
export function ceilingAllowsUnaskedTools(
  ceiling: CliPermissionPreset,
  callerCeiling: CliPermissionPreset | null = null,
): boolean {
  return (
    isMostPermissiveCliPermissionPreset(ceiling) &&
    (callerCeiling === null || isMostPermissiveCliPermissionPreset(callerCeiling))
  )
}
