/** Compact fallback text for a permission card; tool rows use structured input. */
export function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return `${tool}: ${truncate(value.trim())}`
  }
  let json = ''
  try {
    json = JSON.stringify(input) ?? ''
  } catch {
    /* A malformed card still names its tool. */
  }
  return json && json !== '{}' ? `${tool}: ${truncate(json)}` : tool
}
function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 199)}…` : value
}
