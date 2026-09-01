// The Connectors surface "Installed" view — the manage-what-you-have half of the
// surface, relocated wholesale from the (removed) Settings → MCPs / Skill packs /
// Extensions tabs (T3). Browsing and installing connectors live on the Browse
// grid; this view owns the lower-frequency management the grid can't express:
// the read-only cross-primitive inventory (InstalledExtensionsInventory), plus
// active MCP servers (remove) and the custom-MCP form. Everything else about
// skills — sources, browsing, installing, including the bundled built-ins via
// the Multicode source — is the Skills surface's, not this view's; the
// automation server has its own rail destination.

import { useCallback, useMemo, useState, type ReactNode } from 'react'

import type { McpCatalogServer, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type { McpSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Input, OutlineButton, PrimaryButton, Select, type SelectItem } from '../../ui'
import { InstalledExtensionsInventory } from './InstalledExtensionsInventory'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

const MCP_TRANSPORT_ITEMS: SelectItem<'stdio' | 'http'>[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
]

// `ManageNote` was this view's copy of the left tone-bar (MC-2115). Both things
// it carried are informational — what a change did, and what syncing means —
// and information is content, not a notice: they are plain copy now.
function ManageLine({ children }: { children: ReactNode }) {
  return <p className="text-body leading-5 text-[color:var(--text-muted)]">{children}</p>
}

export function ConnectorsManage({
  activeWorkspaceRoot,
  catalogServers = [],
  registryPlugins,
  registryUrl = null,
  onLaunchConnector,
  onUseInAutomation,
  onUseSkillInNewAgent,
}: {
  activeWorkspaceRoot: string | null
  // The MCP catalog (already loaded by the surface) — enriches installed rows
  // with real icons and marks skill-linked entries launchable.
  catalogServers?: McpCatalogServer[]
  // The marketplace registry entries the surface already loaded — the update
  // banner's action needs the full entry to route through updateFromRegistry.
  registryPlugins?: MarketplacePluginEntry[]
  // Where the registry's relative icon paths resolve from (installed CLI rows).
  registryUrl?: string | null
  onLaunchConnector?: (connector: AgentComposerConnector) => void
  onUseInAutomation?: (serverId: string) => void
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}) {
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  // The CLI rows' Update affordance keys off the real availability probe, and
  // a finished update force-reprobes so the row reads what the updater left.
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)

  const [mcpMessage, setMcpMessage] = useState<string | null>(null)
  const [customMcpId, setCustomMcpId] = useState('')
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpCommand, setCustomMcpCommand] = useState('')
  const [customMcpArgs, setCustomMcpArgs] = useState('')
  const [customMcpUrl, setCustomMcpUrl] = useState('')
  const [customMcpEnv, setCustomMcpEnv] = useState('')
  const [customMcpTransport, setCustomMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [addMcpOpen, setAddMcpOpen] = useState(false)

  // The inventory lists skills and modules over IPC, so a successful remove
  // bumps this to remount it and re-list; MCP rows ride the store and need no
  // refresh.
  const [inventoryRefresh, setInventoryRefresh] = useState(0)
  const [skillMessage, setSkillMessage] = useState<string | null>(null)

  // Removing an installed skill takes its directory back out of every harness
  // dir that holds a copy. The outcome is stated: a removal that failed must
  // never leave the row looking gone.
  const removeSkill = useCallback(
    async (dirName: string) => {
      if (!activeWorkspaceRoot) return
      setSkillMessage(null)
      try {
        const result = await window.api.skillsUninstall({ workspaceRoot: activeWorkspaceRoot, dirName })
        setSkillMessage(result.ok ? `${dirName} removed.` : result.message)
        if (result.ok) setInventoryRefresh((count) => count + 1)
      } catch (error) {
        setSkillMessage(error instanceof Error ? error.message : `Failed to remove ${dirName}.`)
      }
    },
    [activeWorkspaceRoot],
  )

  const addCustomMcp = useCallback(() => {
    const id = customMcpId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const name = customMcpName.trim() || id
    if (!id || !name) {
      setMcpMessage('Custom MCP needs an id and name.')
      return
    }
    if (customMcpTransport === 'stdio' && !customMcpCommand.trim()) {
      setMcpMessage('Stdio MCP needs a command.')
      return
    }
    if (customMcpTransport === 'http' && !customMcpUrl.trim()) {
      setMcpMessage('HTTP MCP needs a URL.')
      return
    }
    upsertMcpServer({
      id,
      name,
      transport: customMcpTransport,
      command: customMcpTransport === 'stdio' ? customMcpCommand.trim() : undefined,
      args: splitCommandArgs(customMcpArgs),
      url: customMcpTransport === 'http' ? customMcpUrl.trim() : undefined,
      envVarNames: parseEnvNames(customMcpEnv),
      enabled: true,
      required: false,
      clients: ['codex', 'claude-code'],
      scope: 'workspace',
      source: 'custom',
      riskLevel: customMcpTransport === 'stdio' ? 'local-command' : 'network',
    })
    setCustomMcpId('')
    setCustomMcpName('')
    setCustomMcpCommand('')
    setCustomMcpArgs('')
    setCustomMcpUrl('')
    setCustomMcpEnv('')
    setMcpMessage(null)
    setAddMcpOpen(false)
  }, [
    customMcpArgs,
    customMcpCommand,
    customMcpEnv,
    customMcpId,
    customMcpName,
    customMcpTransport,
    customMcpUrl,
    upsertMcpServer,
  ])

  const mcpServers = useMemo(() => Object.values(mcpSettings.servers), [mcpSettings.servers])

  return (
    <div className="mt-4 space-y-6">
      <section className="space-y-2">
        <InstalledExtensionsInventory
          key={inventoryRefresh}
          mcpServers={mcpServers}
          moduleOverrides={moduleEnablement}
          workspaceRoot={activeWorkspaceRoot}
          catalogServers={catalogServers}
          registryPlugins={registryPlugins}
          registryUrl={registryUrl}
          mcpSettings={mcpSettings}
          cliAvailability={cliAvailability}
          onCliUpdated={() => void refreshCliAvailability({ force: true })}
          onUpsertMcpServer={upsertMcpServer}
          onLaunchConnector={onLaunchConnector}
          onUseInAutomation={onUseInAutomation}
          onRemoveMcpServer={(serverId) => {
            removeMcpServer(serverId)
            setMcpMessage(null)
          }}
          onRemoveSkill={(dirName) => void removeSkill(dirName)}
          onUseSkillInNewAgent={onUseSkillInNewAgent}
        />
        {skillMessage ? <ManageLine>{skillMessage}</ManageLine> : null}
      </section>

      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        {!addMcpOpen ? (
          <OutlineButton size="sm" onClick={() => setAddMcpOpen(true)}>
            Add a custom MCP
          </OutlineButton>
        ) : (
          <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server id" htmlFor="custom-mcp-id">
              <Input
                value={customMcpId}
                onChange={(event) => setCustomMcpId(event.target.value)}
                placeholder="server-id"
                size="md"
                className="font-mono"
              />
            </Field>
            <Field label="Display name" htmlFor="custom-mcp-name">
              <Input
                value={customMcpName}
                onChange={(event) => setCustomMcpName(event.target.value)}
                placeholder="Display name"
                size="md"
              />
            </Field>
            <Field label="Transport" htmlFor="custom-mcp-transport">
              <Select
                ariaLabel="Transport"
                items={MCP_TRANSPORT_ITEMS}
                value={customMcpTransport}
                onChange={setCustomMcpTransport}
                className="h-control-md w-full"
              />
            </Field>
            <Field label={customMcpTransport === 'stdio' ? 'Command' : 'URL'} htmlFor="custom-mcp-endpoint">
              {customMcpTransport === 'stdio' ? (
                <Input
                  value={customMcpCommand}
                  onChange={(event) => setCustomMcpCommand(event.target.value)}
                  placeholder="e.g. npx"
                  size="md"
                  className="font-mono"
                />
              ) : (
                <Input
                  value={customMcpUrl}
                  onChange={(event) => setCustomMcpUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  size="md"
                  className="font-mono"
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Args (space separated)" htmlFor="custom-mcp-args">
                <Input
                  value={customMcpArgs}
                  onChange={(event) => setCustomMcpArgs(event.target.value)}
                  placeholder="e.g. -y @vendor/server"
                  size="md"
                  className="font-mono"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Required env vars (comma separated)" htmlFor="custom-mcp-env">
                <Input
                  value={customMcpEnv}
                  onChange={(event) => setCustomMcpEnv(event.target.value)}
                  placeholder="API_KEY, ANOTHER_VAR"
                  size="md"
                  className="font-mono"
                />
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <GhostButton
              size="sm"
              onClick={() => {
                setAddMcpOpen(false)
                setMcpMessage(null)
              }}
            >
              Cancel
            </GhostButton>
            <PrimaryButton size="sm" onClick={addCustomMcp}>
              Add server
            </PrimaryButton>
          </div>
          </>
        )}

        <ManageLine>
          {mcpMessage || (activeWorkspaceRoot
            ? 'Changes apply automatically across Claude Code, Codex, and other terminal agents. Existing terminals keep their current config until relaunched.'
            : 'Open a workspace folder to sync MCPs to terminal agents.')}
        </ManageLine>
      </section>
    </div>
  )
}

function splitCommandArgs(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseEnvNames(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean)
}
