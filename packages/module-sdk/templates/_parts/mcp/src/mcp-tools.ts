import type { MainHost } from '@sprintengine/module-sdk'

// Tools on the Studio MCP gateway that every agent in every workspace is
// connected to, registered from registerMain (src/main.ts). Needs the
// "mcp:tools" permission.
//
// Tool names are a public contract: prefix them with the module id and keep
// them stable. A tool counts as changing state unless it says
// `mutates: false` — say so on every read-only tool.
export function registerTools(host: MainHost): void {
  const prefix = host.moduleId.replace(/-/g, '_')
  host.registerMcpTools([
    {
      name: `${prefix}_about`,
      description: 'Say which extension this is and which host API it runs on.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: async () => ({
        content: [{ type: 'text', text: `{{displayName}} (${host.moduleId}), host API ${host.hostApiVersion}.` }],
        structuredContent: { moduleId: host.moduleId, hostApiVersion: host.hostApiVersion },
      }),
    },
  ])
}
