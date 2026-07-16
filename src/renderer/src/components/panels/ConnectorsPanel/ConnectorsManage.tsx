// The Connectors surface "Installed" view — the manage-what-you-have half of the
// surface, relocated wholesale from the (removed) Settings → MCPs / Skill packs /
// Extensions tabs (T3). Browsing and installing connectors live on the Browse
// grid; this view owns the lower-frequency management the grid can't express:
//   • the read-only cross-primitive inventory (InstalledExtensionsInventory),
//   • active MCP servers (remove) + a custom-MCP form + the automation server,
//   • bundled built-in skills (install / update) + the skill-pack ecosystem
//     catalog (install / remove).
// This is a presentation-only relocation: every store action and window.api.*
// call is the one the Settings tabs used — no state or IPC changed.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { BuiltinSkill, BuiltinSkillStatus, McpCatalogServer, SkillPackEntry, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type {
  McpSettings,
  SkillPackCatalogEntry,
  SkillPackSettings,
} from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Select, type SelectItem } from '../../ui'
import { McpBrandIcon } from '../../settings/McpCatalog'
import { SkillPackInfoPanel, SkillPackMonogram, groupSkillPackCatalog } from '../../settings/SkillPacksCatalog'
import { AutomationServerSettings } from '../../settings/AutomationServerSettings'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'
import { InstalledExtensionsInventory } from './InstalledExtensionsInventory'

const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }
const EMPTY_SKILL_PACK_SETTINGS: SkillPackSettings = { installed: {} }

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
  const skillPackSettings = useWorkspaceStore((s) => s.appSettings.skillPacks ?? EMPTY_SKILL_PACK_SETTINGS)
  const setSkillPacksInstalled = useWorkspaceStore((s) => s.setSkillPacksInstalled)
  const upsertSkillPack = useWorkspaceStore((s) => s.upsertSkillPack)
  const removeSkillPackFromStore = useWorkspaceStore((s) => s.removeSkillPack)
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

  const [skillPackCatalog, setSkillPackCatalog] = useState<SkillPackCatalogEntry[]>([])
  const [skillPackMessage, setSkillPackMessage] = useState<string | null>(null)
  const [skillPackPendingId, setSkillPackPendingId] = useState<string | null>(null)
  const [selectedSkillPackId, setSelectedSkillPackId] = useState<string | null>(null)
  // The inventory lists skill packs over IPC, so a successful install/remove
  // bumps this to remount it and re-list; MCP rows ride the store and need no
  // refresh.
  const [inventoryRefresh, setInventoryRefresh] = useState(0)

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

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.skillPackListCatalog !== 'function') {
      setSkillPackMessage('Skill packs need an app restart before they are available.')
      return () => {
        cancelled = true
      }
    }
    void window.api.skillPackListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) setSkillPackCatalog(result.packs)
      else setSkillPackMessage(result.message)
    }).catch((error) => {
      if (!cancelled) setSkillPackMessage(error instanceof Error ? error.message : 'Unable to load skill-pack catalog.')
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeWorkspaceRoot) {
      setSkillPacksInstalled([])
      return
    }
    if (typeof window.api.skillPackListInstalled !== 'function') return
    let cancelled = false
    void window.api
      .skillPackListInstalled({ workspaceRoot: activeWorkspaceRoot })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setSkillPacksInstalled(result.installed)
        else setSkillPackMessage(result.message)
      })
      .catch((error) => {
        if (!cancelled) {
          setSkillPackMessage(error instanceof Error ? error.message : 'Unable to read installed skill packs.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceRoot, setSkillPacksInstalled])

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

  const toggleSkillPack = useCallback(
    async (pack: SkillPackCatalogEntry) => {
      if (!activeWorkspaceRoot) {
        setSkillPackMessage('Open a workspace folder before installing skill packs.')
        return
      }
      const installed = skillPackSettings.installed[pack.id]
      setSkillPackPendingId(pack.id)
      setSkillPackMessage(null)
      try {
        if (installed) {
          const result = await window.api.skillPackRemove({
            workspaceRoot: activeWorkspaceRoot,
            slug: pack.slug,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            removeSkillPackFromStore(pack.id)
            setSkillPackMessage(`${pack.name} removed.`)
            setInventoryRefresh((count) => count + 1)
          } else {
            setSkillPackMessage(result.message)
          }
        } else {
          const result = await window.api.skillPackInstall({
            workspaceRoot: activeWorkspaceRoot,
            slug: pack.slug,
            harnesses: pack.harnesses,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            const entry: SkillPackEntry = {
              ...result.installed,
              id: pack.id,
              name: pack.name,
              category: pack.category,
              description: pack.description,
              version: pack.version,
              sourceUrl: pack.sourceUrl,
              installedDirName: pack.installedDirName ?? result.installed.installedDirName,
            }
            upsertSkillPack(entry)
            setSkillPackMessage(
              pack.setupNotes ? `${pack.name} installed. ${pack.setupNotes}` : `${pack.name} installed.`,
            )
            setInventoryRefresh((count) => count + 1)
          } else {
            setSkillPackMessage(result.message)
          }
        }
      } catch (error) {
        setSkillPackMessage(error instanceof Error ? error.message : 'Skill pack action failed.')
      } finally {
        setSkillPackPendingId(null)
      }
    },
    [activeWorkspaceRoot, removeSkillPackFromStore, skillPackSettings.installed, upsertSkillPack],
  )

  // Inventory rows key skill packs by slug; resolve back to the catalog entry
  // (or the store's installed record) and route through the existing
  // toggleSkillPack removal path — no new IPC.
  const removeSkillPackBySlug = useCallback(
    (slug: string) => {
      const catalogEntry = skillPackCatalog.find((entry) => entry.slug === slug)
      if (catalogEntry) {
        void toggleSkillPack(catalogEntry)
        return
      }
      const pack = Object.values(skillPackSettings.installed).find((entry) => entry.slug === slug)
      if (pack) {
        void toggleSkillPack({
          id: pack.id,
          slug: pack.slug,
          name: pack.name,
          installedDirName: pack.installedDirName,
          harnesses: pack.harnesses,
        })
      }
    },
    [skillPackCatalog, skillPackSettings.installed, toggleSkillPack],
  )

  const groupedSkillPackCatalog = useMemo(() => groupSkillPackCatalog(skillPackCatalog), [skillPackCatalog])
  const selectedSkillPack = selectedSkillPackId
    ? skillPackCatalog.find((pack) => pack.id === selectedSkillPackId) ?? null
    : null
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
          onRemoveSkillPack={removeSkillPackBySlug}
          onUseSkillInNewAgent={onUseSkillInNewAgent}
        />
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

      {/* Installed skill packs live in the inventory above (with Remove); the
          get-more ecosystem catalog stays collapsed until asked for, matching
          the Add-a-custom-MCP affordance. */}
      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        <details className="group space-y-3 [&[open]]:space-y-3">
          <summary className="interactive flex cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-2.5 text-[13px] font-semibold text-[color:var(--text-strong)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]">
            <span>Get more skill packs</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums font-mono text-[10px] font-normal text-[color:var(--text-subtle)]">
                {skillPackCatalog.length}
              </span>
              <span aria-hidden className="text-[10px] font-medium text-[color:var(--text-subtle)] transition-transform group-open:rotate-180">▾</span>
            </span>
          </summary>
          <div className="flex gap-4">
            <div className="min-w-0 flex-1 space-y-4">
              {groupedSkillPackCatalog.map(([category, packs]) => (
                <div key={category} className="space-y-2">
                  <ConnectorSectionHeading label={category} count={packs.length} />
                  <div className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
                    {packs.map((pack) => {
                      const installed = Boolean(skillPackSettings.installed[pack.id])
                      const pending = skillPackPendingId === pack.id
                      return (
                        <ConnectorRow
                          key={pack.id}
                          variant="compact"
                          icon={<SkillPackMonogram name={pack.name} size={24} />}
                          name={pack.name}
                          summary={pack.description}
                          selected={selectedSkillPackId === pack.id}
                          onOpen={() =>
                            setSelectedSkillPackId((current) => (current === pack.id ? null : pack.id))
                          }
                          status={installed ? <span>Installed</span> : undefined}
                          actions={
                            <GhostButton
                              size="sm"
                              onClick={() => void toggleSkillPack(pack)}
                              disabled={pending}
                              className="border border-[color:var(--border-default)]"
                            >
                              {pending ? (installed ? 'Removing…' : 'Installing…') : installed ? 'Remove' : 'Install'}
                            </GhostButton>
                          }
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            {selectedSkillPack ? (
              <SkillPackInfoPanel
                pack={selectedSkillPack}
                installed={Boolean(skillPackSettings.installed[selectedSkillPack.id])}
                pending={skillPackPendingId === selectedSkillPack.id}
                onToggle={() => void toggleSkillPack(selectedSkillPack)}
                onClose={() => setSelectedSkillPackId(null)}
              />
            ) : null}
          </div>
        </details>

        {skillPackMessage ? <ManageNote tone="accent">{skillPackMessage}</ManageNote> : null}
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
      return 'Installed with local changes. Multicode will not overwrite it.'
    case 'local':
      return status.message
    default:
      return 'Skill status is unknown.'
  }
}
