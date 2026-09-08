// The Simple Icons slug an MCP server's brand mark is fetched under, given the
// server's id. Two ids do not match their brand's slug, and one has no brand
// mark at all — everything else is its own slug.
//
// It lives beside `ExtensionIcon` and `mcpMonogram` rather than in a Settings
// component, because every surface that draws a server (the connector rows, the
// Extensions door, the composer picker, the workspace aside) needs it and none
// of them can import the Settings component graph.
export function mcpIconSlug(id: string): string | null {
  if (id === 'context7') return null
  if (id === 'openai-docs') return 'openai'
  return id
}
