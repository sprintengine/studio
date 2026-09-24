import {
  removeManagedStudioGatewayFromClaudeWorkspace,
  RETIRED_SPRINTENGINE_MCP_SERVER_ID,
  type McpConfigService,
} from './mcp-config-service'
import type { McpServerConfig, McpSyncInput } from '../shared/electron-api'
import type { TerminalPathStyle } from '../shared/electron-api'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { studioEnvEntry } from '../shared/studio-env'
import { isWindowsPath, toWslPath } from '../shared/host-paths'

export type StudioMcpSyncResult = { ok: true } | { ok: false; message: string }

// A command Linux can only start through interop: a Windows program or script.
const WINDOWS_ONLY_COMMAND = /\.(?:exe|cmd|bat|ps1|com)$/iu

function hostArg(value: string): string {
  return isWindowsPath(value) ? toWslPath(value) : value
}

/**
 * The person's own MCP servers as a CLI running in WSL has to be told about
 * them. Their settings were written on this PC, so a stdio server's `command`
 * and `args` may name `C:\…` or `\\wsl.localhost\…` paths, which a Linux process
 * cannot open; each such path becomes the path in the distribution
 * (`/mnt/c/…`, `/home/…`). Anything that is not a Windows path — a bare
 * `npx`, a flag, a URL — is left exactly as written.
 *
 * A server whose command is a Windows program (`.exe`, `.cmd`, …) can only
 * start through interop, which a distribution may have turned off; it is still
 * written, and a warning says why it may not start.
 */
export function mcpServersForWsl(servers: Record<string, McpServerConfig>): {
  servers: Record<string, McpServerConfig>
  warnings: string[]
} {
  const out: Record<string, McpServerConfig> = {}
  const warnings: string[] = []
  for (const [id, server] of Object.entries(servers)) {
    if (server.transport !== 'stdio' || !server.command) {
      out[id] = server
      continue
    }
    if (WINDOWS_ONLY_COMMAND.test(server.command.trim())) {
      warnings.push(
        `MCP server "${server.name || id}" runs a Windows program (${server.command}). A CLI in WSL can only start it ` +
          'through WSL interop; if the server does not start there, install a Linux build of it in the distribution.',
      )
    }
    out[id] = {
      ...server,
      command: hostArg(server.command),
      ...(server.args ? { args: server.args.map(hostArg) } : {}),
    }
  }
  return { servers: out, warnings }
}

/**
 * Write a launch's MCP configuration, with the app's own gateway server pinned
 * into the workspace target. The gateway is optional to the CLI: losing it
 * reduces Studio integration but must not prevent the agent itself launching.
 *
 * Two passes, not one: the generic writer picks a single target when a user's
 * own servers are user-scoped, and this app-owned entry must never land in a
 * user-global CLI config. The first pass (only when the user has servers to
 * write) carries their settings; the second pins the gateway to the workspace
 * and forgets the retired Sprint Engine server.
 *
 * `studioGatewayDeliveredAtLaunch` says the launch hands the CLI the app's own
 * plugin directory, whose `.mcp.json` already carries the gateway for that one
 * session. Then nothing of the app's is pinned into the workspace: the person's
 * own synced servers are still written (that is their configuration, not ours),
 * and a gateway entry an earlier launch pinned is taken back out.
 */
export async function syncStudioMcpConfig(
  input: McpSyncInput & { executionPathStyle?: TerminalPathStyle; studioGatewayDeliveredAtLaunch?: boolean },
  deps: {
    mcpConfigService: Pick<McpConfigService, 'sync'>
    // The gateway as a stdio server on the machine the CLI runs on: this app's
    // own binary as Node on this machine, the pinned Node and the helper's
    // bridge inside a WSL distribution. Null leaves the gateway out (a WSL
    // machine whose helper is not up).
    studioGateway?: () => { command: string; args: string[]; env: Record<string, string> } | null
    // Where a warning about the person's own servers goes (a Windows program
    // handed to a CLI in WSL). Best-effort; the launch never waits on it.
    warn?: (message: string) => void
  },
): Promise<StudioMcpSyncResult> {
  const { studioGatewayDeliveredAtLaunch, ...rawSyncInput } = input
  let syncInput = rawSyncInput
  if (rawSyncInput.executionPathStyle === 'wsl') {
    const translated = mcpServersForWsl(rawSyncInput.settings.servers)
    for (const warning of translated.warnings) deps.warn?.(warning)
    syncInput = { ...rawSyncInput, settings: { ...rawSyncInput.settings, servers: translated.servers } }
  }
  if (studioGatewayDeliveredAtLaunch) {
    if (syncInput.settings.syncEnabled && Object.keys(syncInput.settings.servers).length > 0) {
      const result = await deps.mcpConfigService.sync(syncInput)
      if (!result.ok) return { ok: false, message: result.message }
    }
    // Best-effort by construction (it never throws): a stale entry that could
    // not be removed costs a duplicate server, never the launch.
    await removeManagedStudioGatewayFromClaudeWorkspace(syncInput.workspaceRoot)
    return { ok: true }
  }

  let syncInputs = [syncInput]

  const studioGateway = deps.studioGateway?.()
  if (studioGateway) {
    const clients = syncInput.clients ?? []
    const cliId = clients.length === 1 ? clients[0] : undefined
    const studioServer: McpServerConfig = {
      id: STUDIO_MCP_SERVER_ID,
      name: STUDIO_MCP_SERVER_NAME,
      description: 'Always-on local control surface for SprintEngine Studio.',
      transport: 'stdio',
      command: studioGateway.command,
      args: studioGateway.args,
      env: { ...studioGateway.env, ...studioEnvEntry('SPRINTENGINE_AGENT_CLI', cliId) },
      enabled: true,
      required: false,
      clients,
      scope: 'workspace',
      source: 'bundled',
      riskLevel: 'local-command',
      capabilities: ['studio'],
    }
    syncInputs = [
      ...(syncInput.settings.syncEnabled && Object.keys(syncInput.settings.servers).length > 0 ? [syncInput] : []),
      {
        ...syncInput,
        pruneUnlistedServers: false,
        // The deleted Sprint Engine's per-run server: forgotten on every pass
        // that pins the gateway, so a workspace that once ran a sprint stops
        // listing a server nothing answers.
        forgetServerIds: [...(syncInput.forgetServerIds ?? []), RETIRED_SPRINTENGINE_MCP_SERVER_ID],
        settings: {
          syncEnabled: true,
          servers: { [studioServer.id]: studioServer },
        },
      },
    ]
  }

  for (const pass of syncInputs) {
    const result = await deps.mcpConfigService.sync(pass)
    if (!result.ok) return { ok: false, message: result.message }
  }
  return { ok: true }
}
