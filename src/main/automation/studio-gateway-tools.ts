import {
  SPRINTENGINE_MUTATING_TOOL_NAMES,
  SPRINTENGINE_TOOL_DEFINITIONS,
} from '../../shared/sprintengineToolNames.generated'
import type { SprintEngineMcpHubService } from '../sprintengine-mcp-hub'
import type { McpToolContribution } from '../module-host/main-host'
import {
  isMcpToolResult,
  isRecord,
  toolError,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'

const APP_MUTATION_TOOLS = new Set([
  'agent.launch',
  'automation.create',
  'automation.run',
  'backlog.assign',
  'backlog.repair',
  'backlog.update',
  'backlog.work',
  'horizon.add_step',
  'horizon.approve',
  'horizon.configure',
  'horizon.create',
  'horizon.merge',
  'horizon.pause',
  'horizon.remove_step',
  'horizon.reorder',
  'horizon.resume',
  'horizon.skip',
  'sprint.artifact.approve',
  'sprint.artifact.request_changes',
  'sprint.cancel',
  'sprint.create',
  'sprint.pr.create',
  'sprint.pr.status',
  'sprint.resume',
  'sprint.set_mode',
  'sprint.task.comment',
  'sprint.task.create',
  'sprint.task.resolve_input',
  'sprint.task.set_status',
  'sprint.task.update',
  'workspace.create',
  // The one review tool that writes: it persists brief.json. The three review
  // reads (list/get-changeset/get-brief) are not mutations.
  'review_submit_brief',
])
const RUN_MUTATION_TOOLS = new Set<string>(SPRINTENGINE_MUTATING_TOOL_NAMES)

// Builds the gateway's per-request tool resolver. Core tools (the app tools
// plus the canonical Sprint Engine run tools) are merged once, failing fast at
// construction on a duplicate. Module-contributed tools are read from the host
// kernel on EVERY call — the gateway is constructed before modules load, and
// availability must follow module enablement live (MC-1855) — and each one is
// gated on its owner's enablement: a disabled module's tools stay listed and
// answer an actionable enable error instead of running (MC-1805 re-homed).
export function createStudioGatewayTools(options: {
  appTools: McpToolRegistration[]
  sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'callRunTool'>
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
  const runTools: McpToolRegistration[] = SPRINTENGINE_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as unknown as Record<string, unknown>,
    handler: (args, context) => callRunTool(
      options.sprintEngineMcpHub,
      definition.name,
      args,
      context ?? { metadata: { kind: 'external-local' } }
    ),
  }))
  for (const registration of runTools) requireUnique(registration.name)
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
    merged.push(...runTools)
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

export function isStudioGatewayMutation(toolName: string): boolean {
  return APP_MUTATION_TOOLS.has(toolName) || RUN_MUTATION_TOOLS.has(toolName)
}
async function callRunTool(
  hub: Pick<SprintEngineMcpHubService, 'callRunTool'>,
  toolName: string,
  args: Record<string, unknown>,
  context: McpConnectionContext
): Promise<McpToolResult> {
  const runId = context.metadata.sprintRunId
  if (!runId) {
    return toolError(
      'no_active_sprint',
      'This MCP connection has no active Sprint Engine run. Launch or enter a sprint in SprintEngine Studio, then use that sprint agent connection.'
    )
  }
  try {
    const result = await hub.callRunTool({ runId, toolName, arguments: args })
    if (isMcpToolResult(result)) return result
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: isRecord(result) ? result : { result },
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const code = /module is disabled|module is unavailable/i.test(text)
      ? 'sprintengine_module_disabled'
      : /not registered|not ready/i.test(text)
        ? 'no_active_sprint'
        : 'sprintengine_proxy_error'
    return toolError(code, text)
  }
}



