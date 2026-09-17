import { BROWSER_MUTATION_TOOL_NAMES } from './browser-tools'
import { CANVAS_MUTATION_TOOL_NAMES } from './canvas-tools'
import type { McpToolContribution } from '../module-host/main-host'
import { TAILNET_MUTATION_TOOL_NAMES } from './tailnet/tailnet-tools'
import {
  toolError,
  type McpToolRegistration,
} from '../../shared/modules/mcp-tools'

const APP_MUTATION_TOOLS = new Set([
  ...BROWSER_MUTATION_TOOL_NAMES,
  // Drawing on a board writes a file in the person's project, so every one of
  // these is audited and needs `<family>:operate` from a remote caller.
  // `canvas.describe`, `canvas.find`, `canvas.list` and `canvas.screenshot`
  // only look, and stay on the read scope.
  ...CANVAS_MUTATION_TOOL_NAMES,
  'agent.launch',
  'automation.create',
  'automation.run',
  'backlog.assign',
  'backlog.repair',
  'backlog.update',
  'backlog.work',
  // Configuring who may drive this machine. Classified as mutations so every
  // one of them is audited — minting a pairing code is the most consequential
  // write on this surface. The tailnet listener never serves them at all
  // (`isLocalOnlyGatewayTool`), so unlike every other entry here their scope
  // mapping is never consulted.
  ...TAILNET_MUTATION_TOOL_NAMES,
  // Opening a terminal on this machine (MC-2166). Classified here and nowhere
  // else: the tailnet scope mapping reads this same classification, so being a
  // mutation is what makes `terminal.create` require `terminal:control` rather
  // than the watch-only `terminal:observe` — and what makes every attempt,
  // including a refused one, land in the audit with the device that made it.
  'terminal.create',
  'workspace.create',
  // The mobile companion's command envelope over the gateway
  // (tailnet-mobile-transport). A mutation for both of its consequences: a
  // paired phone needs `workspace:operate` to drive it, and every dispatch —
  // including a refused one — lands in the audit with the device identity.
  // `workspace.snapshot` deliberately is NOT here: it is the phone's read
  // model and maps to `workspace:read` like every other read.
  'workspace.mobile_command',
])

// Builds the gateway's per-request tool resolver. The app tools are merged once,
// failing fast at construction on a duplicate. Module-contributed tools are read
// from the host kernel on EVERY call — the gateway is constructed before modules
// load, and availability must follow module enablement live (MC-1855) — and each
// one is gated on its owner's enablement: a disabled module's tools stay listed
// and answer an actionable enable error instead of running (MC-1805 re-homed).
export function createStudioGatewayTools(options: {
  appTools: McpToolRegistration[]
  /** Module-contributed tools, from the host kernel; empty until modules load. */
  resolveModuleTools: () => ReadonlyArray<McpToolContribution>
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled: (moduleId: string) => boolean
  warn?: (message: string) => void
}): () => McpToolRegistration[] {
  const coreNames = new Set<string>()
  const requireUnique = (name: string): void => {
    if (coreNames.has(name)) {
      throw new Error(`Duplicate SprintEngine Studio MCP tool registration: ${name}`)
    }
    coreNames.add(name)
  }
  for (const registration of options.appTools) requireUnique(registration.name)
  // The resolver runs per request; a persistent shadowing module would emit the
  // same collision warning on every tools/list without this once-guard.
  const warnedCollisions = new Set<string>()

  return () => {
    const merged = [...options.appTools]
    const names = new Set(coreNames)
    for (const contribution of options.resolveModuleTools()) {
      const { registration } = contribution
      // Module-vs-module collisions are already rejected at registration by
      // the kernel; this guards a module shadowing a CORE tool name, which the
      // kernel cannot know. First (core) wins so the gateway keeps serving.
      if (names.has(registration.name)) {
        const collisionKey = `${contribution.moduleId}:${registration.name}`
        if (!warnedCollisions.has(collisionKey)) {
          warnedCollisions.add(collisionKey)
          options.warn?.(
            `MCP tool "${registration.name}" from module "${contribution.moduleId}" collides with a core gateway tool and is not served.`
          )
        }
        continue
      }
      names.add(registration.name)
      merged.push(gateOnModuleEnablement(contribution, options.isModuleEnabled))
    }
    return merged
  }
}

// The user's module switch reaches the MCP surface (MC-1805 owner ruling): the
// tool keeps being advertised so an agent learns the capability exists, and a
// call while the owner is disabled answers one plain, actionable sentence as a
// normal MCP tool result — never a protocol error, never the orphaned handler.
function gateOnModuleEnablement(
  contribution: McpToolContribution,
  isModuleEnabled: (moduleId: string) => boolean
): McpToolRegistration {
  const { moduleId, moduleDisplayName, registration } = contribution
  return {
    ...registration,
    handler: async (args, context) =>
      isModuleEnabled(moduleId)
        ? registration.handler(args, context)
        : toolError(
            `${moduleId}_module_disabled`,
            `The ${moduleDisplayName} module is disabled. Enable it in Settings → Modules to use ${moduleId} tools.`
          ),
  }
}

// Does this tool change state? Two decisions read it: the tailnet scope a
// remote caller must hold (`<family>:operate` rather than `<family>:read`) and
// whether the call lands in the gateway audit.
//
// Core tools are classified by the table above. A module-contributed tool
// classifies itself, by declaring `mutates: true` on its registration — core
// cannot know what a module's tool does, and a module that ships after this
// build must still be able to say. `resolveTools` is the gateway's own live
// tool resolver, called per question and never captured: a module enabled
// mid-session changes the answer. Callers with no resolver to hand (tests) get
// the core classification alone.
export function isStudioGatewayMutation(
  toolName: string,
  resolveTools?: () => ReadonlyArray<Pick<McpToolRegistration, 'name' | 'mutates'>>
): boolean {
  if (APP_MUTATION_TOOLS.has(toolName)) return true
  if (!resolveTools) return false
  return resolveTools().some((tool) => tool.name === toolName && tool.mutates === true)
}
