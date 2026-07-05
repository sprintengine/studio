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

import type { BuiltinSkill, BuiltinSkillStatus, SkillPackEntry } from '../../../../../shared/electron-api'
import type {
  McpServerConfig,
  McpSettings,
  SkillPackCatalogEntry,
  SkillPackSettings,
} from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, Select, type SelectItem } from '../../ui'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import { SkillPackInfoPanel, SkillPackTile, groupSkillPackCatalog } from '../../settings/SkillPacksCatalog'
import { AutomationServerSettings } from '../../settings/AutomationServerSettings'
import { SettingsSectionTitle } from '../../settings/SettingsAtoms'
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

export function ConnectorsManage({ activeWorkspaceRoot }: { activeWorkspaceRoot: string | null }) {
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

  const activeMcpServers = useMemo(
    () => Object.values(mcpSettings.servers).filter((server) => server.enabled),
    [mcpSettings.servers],
  )
  const groupedSkillPackCatalog = useMemo(() => groupSkillPackCatalog(skillPackCatalog), [skillPackCatalog])
  const selectedSkillPack = selectedSkillPackId
    ? skillPackCatalog.find((pack) => pack.id === selectedSkillPackId) ?? null
    : null
  const installedSkillPacks = Object.values(skillPackSettings.installed)
  const mcpServers = useMemo(() => Object.values(mcpSettings.servers), [mcpSettings.servers])

  return (
    <div className="mt-4 space-y-6">
      <section className="space-y-2">
        <SettingsSectionTitle>Installed</SettingsSectionTitle>
        <InstalledExtensionsInventory
          mcpServers={mcpServers}
          moduleOverrides={moduleEnablement}
          workspaceRoot={activeWorkspaceRoot}
        />
      </section>

      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        <SettingsSectionTitle count={activeMcpServers.length}>MCP servers</SettingsSectionTitle>
        {activeMcpServers.length === 0 ? (
          <ManageNote tone="neutral">
            Nothing active yet. Get an MCP connector from the Browse grid, or add a custom server below.
          </ManageNote>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {activeMcpServers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                onRemove={() => {
                  removeMcpServer(server.id)
                  setMcpMessage(null)
                }}
              />
            ))}
          </ul>
        )}

        <details className="group space-y-3 [&[open]]:space-y-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[color:var(--text-strong)] focus:outline-none focus-visible:underline">
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

      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        <SettingsSectionTitle count={builtinSkills.length}>Bundled skills</SettingsSectionTitle>
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          First-party workflow skills, installed into the workspace targets each agent CLI supports.
        </p>
        <div className="divide-y divide-[color:var(--border-subtle)]">
          {builtinSkills.length ? builtinSkills.map((skill) => {
            const status = builtinSkillStatuses[skill.id] ?? null
            const installBlocked =
              !activeWorkspaceRoot
              || !status
              || !status.ok
              || status.status === 'installed'
              || status.status === 'modified'
              || status.status === 'local'
            return (
              <div key={skill.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">{skill.name}</div>
                  <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">{skill.description}</div>
                  <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
                    {formatBuiltinSkillStatus(status, skill.id)}
                  </div>
                </div>
                <GhostButton
                  size="md"
                  onClick={() => void installBuiltinSkill(skill)}
                  disabled={builtinSkillPendingId !== null || installBlocked}
                  className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                >
                  {status?.ok && status.status === 'update-available' ? 'Update' : 'Install'}
                </GhostButton>
              </div>
            )
          }) : (
            <p className="py-2.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Built-in skills have not loaded yet.
            </p>
          )}
        </div>
        {builtinSkillMessage ? <ManageNote tone="warn">{builtinSkillMessage}</ManageNote> : null}
      </section>

      <section className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
        <SettingsSectionTitle count={installedSkillPacks.length}>Skill packs</SettingsSectionTitle>
        {installedSkillPacks.length === 0 ? (
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Nothing installed yet. Pick a pack from the ecosystem catalog below.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {installedSkillPacks.map((pack) => (
              <li key={pack.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{pack.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">
                    {pack.slug}
                    {pack.harnesses.length ? ` · ${pack.harnesses.join(', ')}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const catalogEntry = skillPackCatalog.find((entry) => entry.id === pack.id)
                    if (catalogEntry) {
                      void toggleSkillPack(catalogEntry)
                      return
                    }
                    void toggleSkillPack({
                      id: pack.id,
                      slug: pack.slug,
                      name: pack.name,
                      installedDirName: pack.installedDirName,
                      harnesses: pack.harnesses,
                    })
                  }}
                  disabled={skillPackPendingId === pack.id}
                  className="text-[12px] font-semibold text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:underline disabled:cursor-progress"
                >
                  {skillPackPendingId === pack.id ? 'Removing' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-4">
          <section className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1">
              <SettingsSectionTitle count={skillPackCatalog.length}>Ecosystem catalog</SettingsSectionTitle>
              <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
                Install runs <code className="font-mono">npx skills add &lt;slug&gt;</code> in the workspace root.
              </p>
            </div>
            <div className="space-y-5">
              {groupedSkillPackCatalog.map(([category, packs]) => (
                <div key={category} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{category}</span>
                    <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                    <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">
                      {packs.length}
                    </span>
                  </div>
                  <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${selectedSkillPack ? '' : 'lg:grid-cols-4'}`}>
                    {packs.map((pack) => (
                      <SkillPackTile
                        key={pack.id}
                        pack={pack}
                        installed={Boolean(skillPackSettings.installed[pack.id])}
                        pending={skillPackPendingId === pack.id}
                        selected={selectedSkillPackId === pack.id}
                        onToggle={() => void toggleSkillPack(pack)}
                        onInfo={() => setSelectedSkillPackId((current) => (current === pack.id ? null : pack.id))}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
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

        {skillPackMessage ? <ManageNote tone="accent">{skillPackMessage}</ManageNote> : null}
      </section>
    </div>
  )
}

function McpServerRow({ server, onRemove }: { server: McpServerConfig; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <McpBrandIcon
          slug={server.source === 'bundled' ? mcpIconSlug(server.id) : null}
          name={server.name}
          size={24}
        />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{server.name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">
            {server.id} · {server.transport} · {server.clients.join(', ')}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-[12px] font-semibold text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:underline"
      >
        Remove
      </button>
    </li>
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
