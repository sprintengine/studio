// `opencode` format: JSON with an `mcp` object keyed by server id, each entry
// either `type: "local"` (an argv array plus `environment`) or `type: "remote"`
// (a URL plus `headers`). The mirror image of `toOpencodeServer` in
// src/main/mcp-config-service.ts, which writes the same two shapes.

import { createFileMcpConfigReader, type McpConfigReader, type RawMcpServer } from './reader'
import { asRecord, stringArray, stringRecord, stringValue } from './values'

export function parseOpencodeMcpServers(raw: string): RawMcpServer[] {
  const root = asRecord(JSON.parse(raw) as unknown)
  if (!root) throw new Error('Expected a JSON object at the root of the MCP config.')
  const mcp = asRecord(root.mcp)
  if (!mcp) return []

  const servers: RawMcpServer[] = []
  for (const [id, value] of Object.entries(mcp)) {
    const config = asRecord(value)
    if (!config) continue
    const type = typeof config.type === 'string' ? config.type.trim() : ''
    const url = stringValue(config.url)
    const command = stringArray(config.command)
    const enabled = config.enabled === false ? false : true

    if (type === 'remote' || (command.length === 0 && url)) {
      if (!url) continue
      servers.push({
        id,
        name: id,
        transport: 'http',
        url,
        headers: stringRecord(config.headers),
        enabled,
      })
      continue
    }
    if (command.length === 0) continue
    servers.push({
      id,
      name: id,
      transport: 'stdio',
      command: command[0],
      args: command.slice(1),
      env: stringRecord(config.environment),
      enabled,
    })
  }
  return servers
}

export const opencodeMcpReader: McpConfigReader = createFileMcpConfigReader('opencode', parseOpencodeMcpServers)
