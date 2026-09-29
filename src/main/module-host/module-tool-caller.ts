// Who is calling a module's MCP tool, for the services the tool's handler
// reaches while it runs.
//
// An agent can only start agents with the permissions it has itself
// (launch-permission-cap.ts). The gateway enforces that on its own launch
// tools, but a module tool is the module's code: one that starts a chat through
// the module conversation service would hand a capped agent's prompt to a
// `bypass` chat, and the cap would be one tool call deep. So the gateway runs
// each module tool handler inside this context, carrying the calling agent's
// ceiling, and the services a module can start an agent through read it.
//
// AsyncLocalStorage follows the handler's own async work (awaits, timers,
// promises it starts), which is exactly the work done on the caller's behalf.
// A listener the module registered before the call runs outside it, as it
// should: that work is not the caller's.

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  isLooserCliPermissionPreset,
  isMostPermissiveCliPermissionPreset,
  type CliPermissionPreset,
} from '../../shared/cli-permission-preset'

type ModuleToolCaller = {
  /** The loosest preset an agent the handler starts may run on; null when the caller is not capped. */
  permissionCeiling: CliPermissionPreset | null
}

const storage = new AsyncLocalStorage<ModuleToolCaller>()

/** Run a module tool handler as `caller`. */
export function runAsModuleToolCall<T>(caller: ModuleToolCaller, handler: () => T): T {
  return storage.run(caller, handler)
}

/**
 * The permission ceiling of the agent whose tool call is running now, or null
 * outside a module tool call or when its caller is not capped.
 */
export function moduleToolCallerCeiling(): CliPermissionPreset | null {
  return storage.getStore()?.permissionCeiling ?? null
}

/**
 * The preset an agent a module starts during a tool call runs on: the one it
 * asked for, lowered to the caller's ceiling when looser, and pinned to the
 * ceiling when it asked for none — the launch default could be looser than
 * the caller. Lowered rather than refused: the module asked, not the agent,
 * and the module cannot know who called it.
 */
export function clampToModuleToolCaller(
  requested: CliPermissionPreset | undefined,
  ceiling: CliPermissionPreset | null = moduleToolCallerCeiling(),
): CliPermissionPreset | undefined {
  if (ceiling === null) return requested
  if (requested === undefined) return isMostPermissiveCliPermissionPreset(ceiling) ? undefined : ceiling
  return isLooserCliPermissionPreset(requested, ceiling) ? ceiling : requested
}
