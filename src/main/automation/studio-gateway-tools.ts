import {
  SPRINTENGINE_MUTATING_TOOL_NAMES,
  SPRINTENGINE_TOOL_DEFINITIONS,
} from '../../shared/sprintengineToolNames.generated'
import type { SprintEngineMcpHubService } from '../sprintengine-mcp-hub'
import type {
  McpConnectionContext,
  McpToolRegistration,
  McpToolResult,
} from './mcp-socket-server'

const APP_MUTATION_TOOLS = new Set([
  'agent.launch',
  'automation.create',
  'automation.run',
  'backlog.assign',
  'backlog.repair',
  'backlog.update',
  'backlog.work',
  'roadmap.add_step',
  'roadmap.approve',
  'roadmap.merge',
  'roadmap.pause',
  'roadmap.remove_step',
  'roadmap.reorder',
  'roadmap.resume',
  'roadmap.skip',
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
])
const RUN_MUTATION_TOOLS = new Set<string>(SPRINTENGINE_MUTATING_TOOL_NAMES)

export function createStudioGatewayTools(options: {
  appTools: McpToolRegistration[]
  sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'callRunTool'>
}): McpToolRegistration[] {
  const names = new Set<string>()
  const merged: McpToolRegistration[] = []
  for (const registration of options.appTools) addUnique(registration)
  for (const definition of SPRINTENGINE_TOOL_DEFINITIONS) {
    addUnique({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as unknown as Record<string, unknown>,
      handler: (args, context) => callRunTool(
        options.sprintEngineMcpHub,
        definition.name,
        args,
        context ?? { metadata: { kind: 'external-local' } }
      ),
    })
  }
  return merged

  function addUnique(registration: McpToolRegistration): void {
    if (names.has(registration.name)) {
      throw new Error(`Duplicate SprintEngine Studio MCP tool registration: ${registration.name}`)
    }
    names.add(registration.name)
    merged.push(registration)
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

function toolError(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true,
  }
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && Array.isArray(value.content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
