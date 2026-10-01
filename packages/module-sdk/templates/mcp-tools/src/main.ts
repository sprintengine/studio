import { WorkspaceContextToken, type McpToolResult, type RegisterMain } from '@sprintengine/module-sdk'

const text = (value: string): McpToolResult => ({ content: [{ type: 'text', text: value }] })
const failure = (value: string): McpToolResult => ({ content: [{ type: 'text', text: value }], isError: true })

// The main entry runs in Studio's main process (Node, no window). Tools
// registered here join the Studio MCP gateway that every agent in every
// workspace is connected to, so an agent can call them by name.
//
// Tool names are a public contract: prefix them with the module id and keep
// them stable. A tool from an installed module counts as changing state
// unless it says `mutates: false` — say so on every read-only tool, so a
// paired device on the read scope can call it.
export const registerMain: RegisterMain = (host) => {
  const prefix = host.moduleId.replace(/-/g, '_')

  host.registerMcpTools([
    {
      name: `${prefix}_word_count`,
      description: 'Count the words, lines and characters in a piece of text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to count.' } },
        required: ['text'],
      },
      mutates: false,
      handler: async (args) => {
        if (typeof args.text !== 'string') return failure('"text" must be a string.')
        const words = args.text.trim() === '' ? 0 : args.text.trim().split(/\s+/).length
        const lines = args.text === '' ? 0 : args.text.split('\n').length
        return {
          ...text(`${words} words, ${lines} lines, ${args.text.length} characters.`),
          structuredContent: { words, lines, characters: args.text.length },
        }
      },
    },
    {
      name: `${prefix}_open_workspaces`,
      description: 'List the workspaces open in SprintEngine Studio, with the folder each one works in.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: async () => {
        // Resolved per call, not at registration: the service's provider may
        // register after this module does.
        const workspaces = await host.requireService(WorkspaceContextToken).list()
        if (workspaces.length === 0) return text('No workspaces are open.')
        return {
          ...text(workspaces.map((w) => `${w.name} — ${w.folderPath ?? '(no folder)'}`).join('\n')),
          structuredContent: { workspaces },
        }
      },
    },
  ])
}
