// The Connectors surface "Installed" view — the manage-what-you-have half of the
// surface, relocated wholesale from the (removed) Settings → MCPs / Skill packs /
// Extensions tabs (T3). Browsing and installing connectors live on the Browse
// grid; this view owns the lower-frequency management the grid can't express:
//   • the read-only cross-primitive inventory (InstalledExtensionsInventory),
//   • active MCP servers (remove) + a custom-MCP form + the automation server,
//   • bundled built-in skills (install / update). Everything else about skills —
//     the sources they come from, browsing and installing them — is the Skills
//     surface's, not this view's.
// This is a presentation-only relocation: every store action and window.api.*
// call is the one the Settings tabs used — no state or IPC changed.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { BuiltinSkill, BuiltinSkillStatus, McpCatalogServer, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type { McpSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Select, type SelectItem } from '../../ui'
import { McpBrandIcon } from '../../settings/McpCatalog'
import { AutomationServerSettings } from '../../settings/AutomationServerSettings'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'
import { InstalledExtensionsInventory } from './InstalledExtensionsInventory'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

const MCP_TRANSPORT_ITEMS: SelectItem<'stdio' | 'http'>[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
]

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 font-mono text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45'

type NoteTone = 'neutral' | 'accent' | 'warn'
const NOTE_BORDER: Record<NoteTone, string> = {
  neutral: 'border-[color:var(--border-strong)]',
  accent: 'border-[color:var(--accent-primary)]',
  warn: 'border-[color:var(--tone-warn)]',
}
const NOTE_TEXT: Record<NoteTone, string> = {
  neutral: 'text-[color:var(--text-muted)]',
  accent: 'text-[color:var(--accent-primary)]',
  warn: 'text-[color:var(--tone-warn)]',
}

function ManageNote({ tone, children }: { tone: NoteTone; children: ReactNode }) {
  return (
    <div className={`border-l-2 pl-3 text-[12px] leading-5 ${NOTE_BORDER[tone]} ${NOTE_TEXT[tone]}`}>{children}</div>
  )
}

export function ConnectorsManage({
  activeWorkspaceRoot,
  catalogServers = [],
  onLaunchConnector,
  onUseInAutomation,
  onUseSkillInNewAgent,
}: {
  activeWorkspaceRoot: string | null
  // The MCP catalog (already loaded by the surface) — enriches installed rows
  // with real icons and marks skill-linked entries launchable.
  catalogServers?: McpCatalogServer[]
  onLaunchConnector?: (connector: AgentComposerConnector) => void
  onUseInAutomation?: (serverId: string) => void
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}) {
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)

  const [mcpMessage, setMcpMessage] = useState<string | null>(null)
  const [customMcpId, setCustomMcpId] = useState('')
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpCommand, setCustomMcpCommand] = useState('')
  const [customMcpArgs, setCustomMcpArgs] = useState('')
  const [customMcpUrl, setCustomMcpUrl] = useState('')
  const [customMcpEnv, setCustomMcpEnv] = useState('')
  const [customMcpTransport, setCustomMcpTransport] = useState<'stdio' | 'http'>('stdio')

  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([])
  const [builtinSkillStatuses, setBuiltinSkillStatuses] = useState<Record<string, BuiltinSkillStatus>>({})
  const [builtinSkillPendingId, setBuiltinSkillPendingId] = useState<string | null>(null)
  const [builtinSkillMessage, setBuiltinSkillMessage] = useState<string | null>(null)

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

  // Bundled built-in skills: list them always; probe per-workspace install status
  // only when a workspace is open (status is workspace-scoped).
  useEffect(() => {
    let cancelled = false
    setBuiltinSkillMessage(null)
    setBuiltinSkillStatuses({})
    void window.api.builtinSkillsList().then(async (skills) => {
      if (cancelled) return
      setBuiltinSkills(skills)
      if (!activeWorkspaceRoot) return
      const statuses = await Promise.all(
        skills.map(async (skill) => {
          const status = await window.api.builtinSkillStatus({ workspaceRoot: activeWorkspaceRoot, skillId: skill.id })
          return [skill.id, status] as const
        }),
      )
      if (!cancelled) setBuiltinSkillStatuses(Object.fromEntries(statuses))
    }).catch((error) => {
      if (!cancelled) setBuiltinSkillMessage(error instanceof Error ? error.message : 'Failed to load built-in skills.')
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceRoot])

  const installBuiltinSkill = useCallback(async (skill: BuiltinSkill) => {
    if (!activeWorkspaceRoot) return
    setBuiltinSkillPendingId(skill.id)
    setBuiltinSkillMessage(null)
    try {
      const result = await window.api.builtinSkillInstall({ workspaceRoot: activeWorkspaceRoot, skillId: skill.id })
      if (result.ok) {
        setBuiltinSkillMessage(result.status === 'updated' ? `${skill.name} updated.` : `${skill.name} installed.`)
        const status = await window.api.builtinSkillStatus({ workspaceRoot: activeWorkspaceRoot, skillId: skill.id })
        setBuiltinSkillStatuses((current) => ({ ...current, [skill.id]: status }))
      } else {
        setBuiltinSkillMessage(result.message)
      }
    } catch (error) {
      setBuiltinSkillMessage(error instanceof Error ? error.message : `Failed to install ${skill.name}.`)
    } finally {
      setBuiltinSkillPendingId(null)
    }
  }, [activeWorkspaceRoot])

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
          onLaunchConnector={onLaunchConnector}
          onUseInAutomation={onUseInAutomation}
          onRemoveMcpServer={(serverId) => {
            removeMcpServer(serverId)
            setMcpMessage(null)
          }}
          onRemoveSkill={(dirName) => void removeSkill(dirName)}
          onUseSkillInNewAgent={onUseSkillInNewAgent}
        />
        {skillMessage ? <ManageNote tone="accent">{skillMessage}</ManageNote> : null}
      </section>

      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        <details className="group space-y-3 [&[open]]:space-y-3">
          {/* Row-sized affordance matching the inventory rows above it. */}
          <summary className="interactive flex cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-2.5 text-[13px] font-semibold text-[color:var(--text-strong)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]">
            <span>Add a custom MCP</span>
            <span aria-hidden className="text-[10px] font-medium text-[color:var(--text-subtle)] transition-transform group-open:rotate-180">▾</span>
          </summary>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server id" htmlFor="custom-mcp-id">
              <input
                value={customMcpId}
                onChange={(event) => setCustomMcpId(event.target.value)}
                placeholder="server-id"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Display name" htmlFor="custom-mcp-name">
              <input
                value={customMcpName}
                onChange={(event) => setCustomMcpName(event.target.value)}
                placeholder="Display name"
                className={`${INPUT_CLASS} font-sans`}
              />
            </Field>
            <Field label="Transport" htmlFor="custom-mcp-transport">
              <Select
                ariaLabel="Transport"
                items={MCP_TRANSPORT_ITEMS}
                value={customMcpTransport}
                onChange={setCustomMcpTransport}
                className="h-9 w-full"
              />
            </Field>
            <Field label={customMcpTransport === 'stdio' ? 'Command' : 'URL'} htmlFor="custom-mcp-endpoint">
              {customMcpTransport === 'stdio' ? (
                <input
                  value={customMcpCommand}
                  onChange={(event) => setCustomMcpCommand(event.target.value)}
                  placeholder="e.g. npx"
                  className={INPUT_CLASS}
                />
              ) : (
                <input
                  value={customMcpUrl}
                  onChange={(event) => setCustomMcpUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                  className={INPUT_CLASS}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Args (space separated)" htmlFor="custom-mcp-args">
                <input
                  value={customMcpArgs}
                  onChange={(event) => setCustomMcpArgs(event.target.value)}
                  placeholder="e.g. -y @vendor/server"
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Required env vars (comma separated)" htmlFor="custom-mcp-env">
                <input
                  value={customMcpEnv}
                  onChange={(event) => setCustomMcpEnv(event.target.value)}
                  placeholder="API_KEY, ANOTHER_VAR"
                  className={INPUT_CLASS}
                />
              </Field>
            </div>
          </div>
          <div className="flex justify-end">
            <GhostButton
              size="md"
              onClick={addCustomMcp}
              className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              Add custom MCP
            </GhostButton>
          </div>
        </details>

        <ManageNote tone={mcpMessage ? 'accent' : 'neutral'}>
          {mcpMessage || (activeWorkspaceRoot
            ? 'Changes apply automatically across Claude Code, Codex, and other terminal agents. Existing terminals keep their current config until relaunched.'
            : 'Open a workspace folder to sync MCPs to terminal agents.')}
        </ManageNote>

        <AutomationServerSettings />
      </section>

      <section className="space-y-2 border-t border-[color:var(--border-subtle)] pt-5">
        <ConnectorSectionHeading label="Bundled skills" count={builtinSkills.length} />
        {builtinSkills.length ? (
          <div className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
            {builtinSkills.map((skill) => {
              const status = builtinSkillStatuses[skill.id] ?? null
              const actionable =
                Boolean(activeWorkspaceRoot)
                && status?.ok === true
                && (status.status === 'missing' || status.status === 'update-available')
              return (
                <ConnectorRow
                  key={skill.id}
                  variant="compact"
                  icon={<McpBrandIcon slug={null} name={skill.name} size={24} />}
                  name={skill.name}
                  // The full description + install detail live in the hover
                  // tooltip; the row keeps a short status only.
                  summary={`${skill.description} — ${formatBuiltinSkillStatus(status, skill.id)}`}
                  status={<span>{builtinSkillShortStatus(status)}</span>}
                  actions={
                    actionable ? (
                      <GhostButton
                        size="sm"
                        onClick={() => void installBuiltinSkill(skill)}
                        disabled={builtinSkillPendingId !== null}
                        className="border border-[color:var(--border-default)]"
                      >
                        {status?.ok && status.status === 'update-available' ? 'Update' : 'Install'}
                      </GhostButton>
                    ) : undefined
                  }
                />
              )
            })}
          </div>
        ) : (
          <p className="py-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
            Built-in skills have not loaded yet.
          </p>
        )}
        {builtinSkillMessage ? <ManageNote tone="warn">{builtinSkillMessage}</ManageNote> : null}
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

// The compact row's visible status — one or two words; the long sentence from
// formatBuiltinSkillStatus rides the row tooltip instead.
function builtinSkillShortStatus(status: BuiltinSkillStatus | null): string {
  if (!status) return ''
  if (!status.ok) return 'Unavailable'
  switch (status.status) {
    case 'missing':
      return 'Not installed'
    case 'installed':
      return 'Installed'
    case 'update-available':
      return 'Update available'
    case 'modified':
      return 'Modified locally'
    case 'local':
      return 'Local copy'
    default:
      return ''
  }
}

function formatBuiltinSkillStatus(status: BuiltinSkillStatus | null, skillId: string): string {
  if (!status) return 'Skill status has not been checked.'
  if (!status.ok) return status.message
  const nativeTargets = status.targets.filter(
    (target) => target.support !== 'unsupported' && target.status !== 'unsupported' && target.status !== 'prompt-shim',
  )
  const installedNativeTargets = nativeTargets.filter(
    (target) =>
      target.status === 'installed'
      || target.status === 'update-available'
      || target.status === 'modified'
      || target.status === 'local',
  )
  const promptShimCount = status.targets.filter((target) => target.status === 'prompt-shim').length
  const unsupportedCount = status.targets.filter((target) => target.status === 'unsupported').length

  switch (status.status) {
    case 'missing':
      return nativeTargets.length > 1
        ? `Not installed. ${nativeTargets.length} native targets available.`
        : 'Not installed in this workspace.'
    case 'installed':
      if (installedNativeTargets.length > 1) {
        return `Installed in ${installedNativeTargets.length} native targets${promptShimCount ? `; ${promptShimCount} prompt-shim CLI${promptShimCount === 1 ? '' : 's'}` : ''}${unsupportedCount ? `; ${unsupportedCount} unsupported CLI${unsupportedCount === 1 ? '' : 's'}` : ''}.`
      }
      return `Installed in .agents/skills/${skillId}.`
    case 'update-available':
      return `Update available. Installed version: ${status.installedVersion}.`
    case 'modified':
      return 'Installed with local changes. It will not be overwritten.'
    case 'local':
      return status.message
    default:
      return 'Skill status is unknown.'
  }
}
