// Reading which MCP servers a CLI is actually configured with.
//
// The write path (src/main/mcp-config-service.ts) is already manifest-driven:
// each plugin declares `mcpConfig.path`, `mcpConfig.userPath` and
// `mcpConfig.format`, and the writer renders the right shape into the right
// file. This is the same map read backwards — one adapter per declared format,
// looked up by key in src/main/mcp-config-readers/registry.ts. A thirteenth CLI
// on a new format is a new adapter file and a registry line, never another case
// in a switch, and no config path is ever written as a literal outside a
// plugin manifest.

import { readFile } from 'fs/promises'

import type { McpTransport } from '../../shared/electron-api'
import type { PluginMcpConfigFormat } from '../../shared/plugin-manifest'

/**
 * One server entry exactly as a CLI's own config file states it, before it is
 * attributed to a CLI or normalised into anything the app owns. The same shape
 * feeds the agent-capability read path and the import wizard's detection, so
 * there is one parser per format rather than two that eventually disagree.
 */
export type RawMcpServer = {
  id: string
  name?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled?: boolean
}

/**
 * `missing`, `unreadable` and `malformed` are three different answers on
 * purpose. A config file the CLI never created is normal; one that could not be
 * opened is a fault; and one that opened but could not be parsed is a different
 * fault — the likeliest real-world one here, since rendering a `.mcp.json` with
 * a syntax error as "no servers" would be a lie.
 */
export type ReadServersResult =
  { ok: true; servers: RawMcpServer[] } | { ok: false; reason: 'missing' | 'unreadable' | 'malformed'; message: string }

export interface McpConfigReader {
  format: PluginMcpConfigFormat
  read(absolutePath: string): Promise<ReadServersResult>
}

/**
 * The filesystem half every adapter shares: read the bytes, map the errno to a
 * reason, and let the format's own parser throw for anything it cannot make
 * sense of. Adapters stay pure string → servers functions, which is also what
 * makes them testable against a fixture without touching disk.
 */
export function createFileMcpConfigReader(
  format: PluginMcpConfigFormat,
  parse: (raw: string) => RawMcpServer[],
): McpConfigReader {
  return {
    format,
    async read(absolutePath): Promise<ReadServersResult> {
      let raw: string
      try {
        raw = await readFile(absolutePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, reason: 'missing', message: 'No MCP config file here.' }
        }
        return { ok: false, reason: 'unreadable', message: errorMessage(error) }
      }
      try {
        return { ok: true, servers: parse(raw) }
      } catch (error) {
        return { ok: false, reason: 'malformed', message: errorMessage(error) }
      }
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
