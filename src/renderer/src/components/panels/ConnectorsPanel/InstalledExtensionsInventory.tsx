// The installed-extensions inventory, relocated from the (removed) Settings →
// Extensions tab into the Connectors surface (T3). It is the aggregated roll-up
// of everything installed across the four extension primitives — MCP servers,
// skill packs, agent CLIs, and capability modules — so the Connectors
// "Installed" view has one honest "what do I have" surface. Rows render the same
// ConnectorRow as Browse so the whole surface reads as one system. The
// list-building lives in the DOM-free `extensionsInstalled` view-model for unit
// coverage; this component owns the IPC loading and rendering, and its per-row
// actions (launch / automation / remove) only delegate to handlers the host
// already owns — a primitive with no handler simply shows no action.

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import type { ModuleEnablementOverrides, ThirdPartyModuleListResult } from '../../../../../shared/modules/manifest'
import type { McpCatalogServer, SkillPackEntry, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../../types/workspace'
import { GhostButton, InlineNotice, Popover, PrimaryButton, Spinner, StatusDot } from '../../ui'
import { bracketedPaste } from '../../../utils/terminalDrop'
import {
  ensureSkillForAgent,
  renderSkillInvocation,
  skillInstalledForHarness,
} from '../../../utils/skillInvocation'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import { TRUST_PRESENTATION } from '../../settings/ThirdPartyModuleList'
import {
  deriveInstalledExtensions,
  type ExtensionsInstalledView,
  type InstalledExtension,
  type LoadedSource,
  type SourceNotice,
} from '../../settings/extensionsInstalled'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'

// Per-row actions, all optional: the host wires only the handlers that exist
// today (no new IPC), and rows without a matching handler carry no affordance.
type InventoryActions = {
  // Catalog entries enrich MCP rows: real icon, and skill-linked entries get the
  // launch affordances.
  catalogServers?: McpCatalogServer[]
  onLaunchConnector?: (connector: AgentComposerConnector) => void
  onUseInAutomation?: (serverId: string) => void
  onRemoveMcpServer?: (serverId: string) => void
  // Keyed by the pack slug (the inventory row id for skill packs).
  onRemoveSkillPack?: (slug: string) => void
  // "Use in agent → New agent…": spawn a fresh agent with the skill attached
  // (ensure-installed, invocation prefilled). Running-agent inserts are handled
  // inside the row menu itself via the terminal APIs.
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}

export function InstalledExtensionsInventory({
  mcpServers,
  moduleOverrides,
  workspaceRoot,
  ...actions
}: {
  // MCP servers reflect the store live, so the inventory's MCP group updates
  // without a re-list when a server is added or removed elsewhere on the surface.
  mcpServers: McpServerConfig[]
  moduleOverrides: ModuleEnablementOverrides
  workspaceRoot: string | null
} & InventoryActions) {
  const [modules, setModules] = useState<LoadedSource<ThirdPartyModuleListResult>>({ status: 'loading' })
  const [skillPacks, setSkillPacks] = useState<LoadedSource<SkillPackEntry[]>>({ status: 'loading' })
  const [clis, setClis] = useState<LoadedSource<PluginRegistryListEntry[]>>({ status: 'loading' })

  const loadModules = useCallback(async () => {
    if (typeof window.api.listThirdPartyModules !== 'function') {
      setModules({ status: 'unsupported' })
      return
    }
    try {
      setModules({ status: 'ok', value: await window.api.listThirdPartyModules() })
    } catch (error) {
      setModules({ status: 'error', message: errorMessage(error, 'Could not list installed modules.') })
    }
  }, [])

  const loadClis = useCallback(async () => {
    if (typeof window.api.pluginsList !== 'function') {
      setClis({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.pluginsList()
      setClis(result.ok ? { status: 'ok', value: result.plugins } : { status: 'error', message: result.message })
    } catch (error) {
      setClis({ status: 'error', message: errorMessage(error, 'Could not list installed agent CLIs.') })
    }
  }, [])

  const loadSkillPacks = useCallback(async () => {
    if (typeof window.api.skillPackListInstalled !== 'function') {
      setSkillPacks({ status: 'unsupported' })
      return
    }
    if (!workspaceRoot) {
      setSkillPacks({ status: 'unavailable', reason: 'Open a workspace to see its installed skill packs.' })
      return
    }
    try {
      const result = await window.api.skillPackListInstalled({ workspaceRoot })
      setSkillPacks(
        result.ok ? { status: 'ok', value: result.installed } : { status: 'error', message: result.message },
      )
    } catch (error) {
      setSkillPacks({ status: 'error', message: errorMessage(error, 'Could not list installed skill packs.') })
    }
  }, [workspaceRoot])

  useEffect(() => {
    void loadModules()
    void loadClis()
  }, [loadModules, loadClis])

  // Skill packs are workspace-scoped, so re-list when the active workspace
  // changes (loadSkillPacks closes over workspaceRoot).
  useEffect(() => {
    setSkillPacks({ status: 'loading' })
    void loadSkillPacks()
  }, [loadSkillPacks])

  const view = deriveInstalledExtensions({
    mcpServers,
    modules,
    moduleOverrides,
    skillPacks,
    clis,
  })

  return (
    <InstalledView
      view={view}
      actions={actions}
      skillUse={{ workspaceRoot, clis: clis.status === 'ok' ? clis.value : [] }}
    />
  )
}

// Context the per-row "Use in agent" menu needs: the workspace whose skill
// inventory resolves the row, and the CLI plugin list whose skillIntegration
// templates render the per-CLI invocation.
type SkillUseContext = {
  workspaceRoot: string | null
  clis: PluginRegistryListEntry[]
}

function NoticeList({ notices }: { notices: SourceNotice[] }) {
  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <InlineNotice key={`${notice.kind}:${notice.message}`} tone={notice.tone}>
          {notice.message}
        </InlineNotice>
      ))}
    </div>
  )
}

function InstalledView({
  view,
  actions,
  skillUse,
}: {
  view: ExtensionsInstalledView
  actions: InventoryActions
  skillUse: SkillUseContext
}) {
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading installed extensions…
      </div>
    )
  }

  if (view.status === 'unsupported') {
    return (
      <InlineNotice tone="warn">
        Installed extensions need a newer app build. Update Multicode and restart to see them here.
      </InlineNotice>
    )
  }

  // Degraded: zero rows but a source failed/was unavailable. Show only the
  // notices that explain why — never the "nothing installed" copy beneath them.
  if (view.status === 'degraded') {
    return <NoticeList notices={view.notices} />
  }

  if (view.status === 'empty') {
    return (
      <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
        Nothing installed yet. Get MCP servers, skill packs, agent CLIs, or modules from the Browse view and they appear
        here.
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {view.notices.length > 0 ? <NoticeList notices={view.notices} /> : null}
      <div className="space-y-5">
        {view.groups.map((group) => (
          <section key={group.kind} className="space-y-2">
            <ConnectorSectionHeading label={group.label} count={group.items.length} />
            <div className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
              {group.items.map((item) => (
                <InstalledRow key={item.key} item={item} actions={actions} skillUse={skillUse} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// One inventory row on the shared ConnectorRow: icon chip · name · human summary
// · neutral metadata chips · plain-language status · actions revealed on
// hover/focus. Actions exist only where a real handler does: launch/automation
// for any enabled MCP server (the connector chat attaches it with or without a
// driving skill), remove for MCP servers and skill packs.
function InstalledRow({
  item,
  actions,
  skillUse,
}: {
  item: InstalledExtension
  actions: InventoryActions
  skillUse: SkillUseContext
}) {
  const catalogEntry =
    item.kind === 'mcp' ? actions.catalogServers?.find((server) => server.id === item.id) : undefined
  const launchable = item.kind === 'mcp' && item.enabled === true

  const rowActions: ReactNode[] = []
  if (item.kind === 'mcp') {
    if (launchable && actions.onUseInAutomation) {
      rowActions.push(
        <GhostButton key="automation" size="sm" onClick={() => actions.onUseInAutomation!(item.id)}>
          Use in automation
        </GhostButton>,
      )
    }
    if (launchable && actions.onLaunchConnector) {
      rowActions.push(
        <PrimaryButton
          key="launch"
          size="sm"
          onClick={() => actions.onLaunchConnector!({ id: item.id, name: item.name, icon: catalogEntry?.icon })}
        >
          New chat
        </PrimaryButton>,
      )
    }
    if (actions.onRemoveMcpServer) {
      rowActions.push(
        <GhostButton
          key="remove"
          size="sm"
          onClick={() => actions.onRemoveMcpServer!(item.id)}
          className="border border-[color:var(--border-default)]"
          aria-label={`Remove ${item.name}`}
        >
          Remove
        </GhostButton>,
      )
    }
  } else if (item.kind === 'skill-pack') {
    if (skillUse.workspaceRoot) {
      rowActions.push(
        <UseSkillMenu
          key="use"
          slug={item.id}
          name={item.name}
          skillUse={skillUse}
          onNewAgent={actions.onUseSkillInNewAgent}
        />,
      )
    }
    if (actions.onRemoveSkillPack) {
      rowActions.push(
        <GhostButton
          key="remove"
          size="sm"
          onClick={() => actions.onRemoveSkillPack!(item.id)}
          className="border border-[color:var(--border-default)]"
          aria-label={`Remove ${item.name}`}
        >
          Remove
        </GhostButton>,
      )
    }
  }

  return (
    <ConnectorRow
      variant="compact"
      icon={
        <McpBrandIcon
          slug={item.kind === 'mcp' && item.source === 'Bundled' ? mcpIconSlug(item.id) : null}
          name={item.name}
          icon={catalogEntry?.icon}
          size={24}
        />
      }
      name={item.name}
      summary={item.summary}
      chips={item.chips}
      status={
        item.kind === 'mcp' || (item.kind === 'module' && item.trust) ? <RowStatus item={item} /> : undefined
      }
      actions={
        rowActions.length > 0 ? (
          <span className="flex items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {rowActions}
          </span>
        ) : undefined
      }
    />
  )
}

// The row's decision-relevant status — trust for capability modules,
// active/inactive for MCP servers — as a StatusDot always paired with its text
// label, so status is never colour-only. Skill packs and CLIs have no such axis
// (presence is the only state), so they carry no dot.
function RowStatus({ item }: { item: InstalledExtension }) {
  if (item.kind === 'module' && item.trust) {
    const trust = TRUST_PRESENTATION[item.trust]
    return (
      <>
        {/* Decorative: the adjacent label already names the trust state. */}
        <StatusDot tone={trust.tone} />
        {trust.label}
      </>
    )
  }
  if (item.kind === 'mcp') {
    return (
      <>
        <StatusDot tone={item.enabled ? 'good' : 'neutral'} />
        {item.enabled ? 'Active' : 'Not active'}
      </>
    )
  }
  return null
}

// "Use in agent" on a skill row: a menu of running agent terminals by name
// ("New agent…" always last). Picking a session ensure-installs the skill,
// renders the per-CLI invocation via the plugin skillIntegration templates, and
// bracket-pastes it at that agent's prompt — unsubmitted, like every other
// door. Worktree agents are excluded (they don't read the main checkout's
// harness dirs).
function UseSkillMenu({
  slug,
  name,
  skillUse,
  onNewAgent,
}: {
  slug: string
  name: string
  skillUse: SkillUseContext
  onNewAgent?: (skill: WorkspaceSkill) => void
}) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<TerminalSessionSnapshot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSessions(null)
    setError(null)
    window.api
      .terminalList()
      .then((all) => {
        if (cancelled) return
        setSessions(
          all.filter(
            (session) =>
              session.kind === 'agent'
              && session.processAlive
              && session.executionMode !== 'worktree'
              && !session.worktreePath,
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // The row is a SkillPackEntry projection; the unified inventory record (with
  // source, harnesses, install slug) is what the invocation machinery needs.
  const resolveSkill = async (): Promise<WorkspaceSkill | null> => {
    if (!skillUse.workspaceRoot) return null
    const result = await window.api.workspaceSkillsList({ workspaceRoot: skillUse.workspaceRoot })
    if (!result.ok) {
      setError(result.message)
      return null
    }
    return result.skills.find((skill) => skill.packSlug === slug || skill.id === slug) ?? null
  }

  const insertIntoSession = async (session: TerminalSessionSnapshot) => {
    if (busy || !skillUse.workspaceRoot) return
    setBusy(true)
    setError(null)
    try {
      const skill = await resolveSkill()
      if (!skill) {
        setError((current) => current ?? 'This skill is missing from the workspace inventory.')
        return
      }
      const ensured = await ensureSkillForAgent({ workspaceRoot: skillUse.workspaceRoot, skill })
      if (!ensured.ok) {
        setError(ensured.message)
        return
      }
      const integration = session.cli
        ? skillUse.clis.find((plugin) => plugin.id === session.cli)?.skillIntegration
        : undefined
      const invocation = renderSkillInvocation({
        skill,
        integration,
        nativeInstalled: skillInstalledForHarness(skill, integration),
      })
      await window.api.terminalWrite(session.sessionId, bracketedPaste(`${invocation} `))
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const startNewAgent = async () => {
    if (busy || !onNewAgent) return
    setBusy(true)
    setError(null)
    try {
      const skill = await resolveSkill()
      if (!skill) {
        setError((current) => current ?? 'This skill is missing from the workspace inventory.')
        return
      }
      setOpen(false)
      onNewAgent(skill)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Use ${name} in an agent`}
      popupRole="menu"
      placement="bottom-end"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="interactive inline-flex h-7 items-center justify-center gap-1.5 rounded-[5px] border border-[color:var(--border-default)] px-2 text-[12px] font-medium text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--bg-hover)]"
          {...triggerProps}
        >
          Use in agent
        </button>
      )}
    >
      <div className="flex w-[240px] flex-col p-1">
        {error ? (
          <div className="px-2.5 py-1.5 text-[11.5px] text-[color:var(--tone-error)]" role="status">
            {error}
          </div>
        ) : null}
        {sessions === null ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-[color:var(--text-muted)]" role="status">
            <Spinner size={14} />
            Finding running agents…
          </div>
        ) : (
          <>
            {sessions.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[11.5px] text-[color:var(--text-subtle)]">
                No running agents
              </div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void insertIntoSession(session)}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12.5px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {session.agentSession?.displayName ?? session.agentId ?? session.sessionId}
                  </span>
                  {session.cli ? (
                    <span className="shrink-0 text-[10.5px] text-[color:var(--text-subtle)]">{session.cli}</span>
                  ) : null}
                </button>
              ))
            )}
            {onNewAgent ? (
              <>
                <div className="mx-2 my-1 border-t border-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void startNewAgent()}
                  className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-[12.5px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:cursor-wait disabled:opacity-60"
                >
                  New agent…
                </button>
              </>
            ) : null}
          </>
        )}
      </div>
    </Popover>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
