// Add an MCP server the catalogue does not carry.
//
// This was the lower half of `ConnectorsManage`, whose upper half was the
// cross-primitive inventory. The source-tabs ruling (2026-09-05) made that
// inventory the Installed TAB of each catalogue, so what is left is the one
// thing the tab cannot express: a server nobody published, described by hand.
// It lives at the foot of the Plugins view's Installed tab, behind a
// disclosure — the rarest act on the surface, so it does not open a form over
// the list of what is already there.

import { useCallback, useState, type ReactNode } from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Input, OutlineButton, PrimaryButton, Select, type SelectItem } from '../../ui'

const MCP_TRANSPORT_ITEMS: SelectItem<'stdio' | 'http'>[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
]

// What a change did, and what syncing means: both informational, and
// information is content, not a notice (MC-2115) — so, plain copy.
function ManageLine({ children }: { children: ReactNode }) {
  return <p className="text-body leading-5 text-[color:var(--text-muted)]">{children}</p>
}

export function CustomMcpServerForm({
  activeWorkspaceRoot,
}: {
  activeWorkspaceRoot: string | null
}) {
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)

  const [mcpMessage, setMcpMessage] = useState<string | null>(null)
  const [customMcpId, setCustomMcpId] = useState('')
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpCommand, setCustomMcpCommand] = useState('')
  const [customMcpArgs, setCustomMcpArgs] = useState('')
  const [customMcpUrl, setCustomMcpUrl] = useState('')
  const [customMcpEnv, setCustomMcpEnv] = useState('')
  const [customMcpTransport, setCustomMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [addMcpOpen, setAddMcpOpen] = useState(false)

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

  return (
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
