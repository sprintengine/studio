// MCP tool contract for the Studio gateway (MC-1855). Node-free on purpose:
// these shapes are shared by the socket server (src/main/automation), the
// module host's contribution point (MainHost.registerMcpTools), and the SDK
// mirror in packages/module-sdk — src/shared cannot import src/main (TS6307).

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, context?: McpConnectionContext) => Promise<McpToolResult>
}

export type McpConnectionMetadata = {
  kind: 'studio-agent' | 'external-local'
  workspaceId?: string
  agentId?: string
  agentName?: string
  cliId?: string
  sprintRunId?: string
}

export type McpConnectionContext = {
  metadata: McpConnectionMetadata
}
