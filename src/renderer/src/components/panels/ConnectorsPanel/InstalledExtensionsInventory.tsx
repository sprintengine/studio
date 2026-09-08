// The installed-extensions inventory, relocated from the (removed) Settings →
// Extensions tab into the Connectors surface (T3). It is the aggregated roll-up
// of everything installed across the four extension primitives — MCP servers,
// skills, agent CLIs, and capability modules — so the Connectors
// "Installed" view has one honest "what do I have" surface. Rows render the same
// ConnectorRow as Browse so the whole surface reads as one system. The
// list-building lives in the DOM-free `extensionsInstalled` view-model for unit
// coverage; this component owns the IPC loading and rendering, and its per-row
// actions (launch / automation / remove) only delegate to handlers the host
// already owns — a primitive with no handler simply shows no action.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { ModuleEnablementOverrides, ThirdPartyModuleListResult } from '../../../../../shared/modules/manifest'
import type {
  AgentCliAvailabilityMap,
  InstalledPluginRecord,
  MarketplaceUpdateStatesResult,
  WorkspaceSkill,
} from '../../../../../shared/electron-api'
import type { SkillSource } from '../../../../../shared/skills'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { CapabilityPermission } from '../../../../../shared/modules/permissions'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import type { McpServerConfig, McpSettings } from '../../../types/workspace'
import {
  CloseIconButton,
  EmptyState,
  GhostButton,
  InlineNotice,
  Pager,
  MENU_LIST_CLASS,
  MenuDivider,
  MenuItem,
  OutlineButton,
  Popover,
  PrimaryButton,
  roveMenuFocus,
  Spinner,
  StatusDot,
  Tooltip,
} from '../../ui'
import { bracketedPaste } from '../../../utils/terminalDrop'
import {
  ensureSkillForAgent,
  renderSkillInvocation,
  skillInstalledForHarness,
} from '../../../utils/skillInvocation'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import { TRUST_PRESENTATION } from '../../settings/ThirdPartyModuleList'
import { pluginTrust } from '../../settings/BrowseStorefront'
import { classifyVerification, summarizeInstallResult } from '../../settings/installFlow'
import {
  deriveInstalledExtensions,
  NO_LONGER_IN_SOURCE,
  type ExtensionKind,
  type ExtensionsInstalledView,
  type InstalledExtension,
  type LoadedSource,
  type SourceNotice,
} from '../../settings/extensionsInstalled'
import {
  CATALOGUE_PAGE_SIZE,
  deriveCataloguePage,
  stepCataloguePage,
} from '../../workspace/globalSurface/extensions/catalogue/cataloguePaging'
import { groupInstalledBySource } from '../../workspace/globalSurface/extensions/catalogue/installedGroups'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'
import {
  ModuleUpdateBanner,
  type ModuleUpdateFlow,
  type ModuleUpdateNotice,
} from './ExtensionUpdateBanner'
import { cliOnlyRegistryIds, deriveManageUpdateBanner } from './extensionUpdates'

// Per-row actions, all optional: the host wires only the handlers that exist
// today (no new IPC), and rows without a matching handler carry no affordance.
type InventoryActions = {
  // Where the registry's relative icon paths resolve from, so an installed CLI
  // wears the same mark its Browse row does.
  registryUrl?: string | null
  onLaunchConnector?: (connector: AgentComposerConnector) => void
  onUseInAutomation?: (serverId: string) => void
  onRemoveMcpServer?: (serverId: string) => void
  // A module-bundle update can carry MCP servers; reflecting them in the store
  // keeps the MCP group live without a re-list (the storefront install rule).
  onUpsertMcpServer?: (server: McpServerConfig) => void
  // Keyed by the skill's directory name (the inventory row id for skills).
  onRemoveSkill?: (dirName: string) => void
  // "Use in agent → New agent…": spawn a fresh agent with the skill attached
  // (ensure-installed, invocation prefilled). Running-agent inserts are handled
  // inside the row menu itself via the terminal APIs.
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}

// The banner's update run: what is being verified/updated now, what is queued
// behind it ("Update all"), and the trust re-classification pause. Internal —
// the banner renders the derived ModuleUpdateFlow.
type ModuleUpdateRun =
  | { status: 'idle' }
  | { status: 'busy'; label: string }
  | {
      status: 'needs-trust'
      entry: MarketplacePluginEntry
      queue: string[]
      permissions: CapabilityPermission[]
      files: string[] | null
      pinnedRef: string | null
    }

export function InstalledExtensionsInventory({
  mcpServers,
  moduleOverrides,
  workspaceRoot,
  registryPlugins,
  mcpSettings,
  cliAvailability,
  onCliUpdated,
  kinds,
  sourceGrouping,
  paging,
  ...actions
}: {
  // MCP servers reflect the store live, so the inventory's MCP group updates
  // without a re-list when a server is added or removed elsewhere on the surface.
  mcpServers: McpServerConfig[]
  moduleOverrides: ModuleEnablementOverrides
  workspaceRoot: string | null
  // The marketplace registry entries the surface already loaded: the update
  // action needs the full entry (updateFromRegistry input), and cli-only
  // entries are excluded from the banner's delta claims.
  registryPlugins?: MarketplacePluginEntry[]
  // Forwarded into the update input so a bundle's MCP servers merge the same
  // way the storefront install merges them.
  mcpSettings?: McpSettings
  // Which CLI binaries are really installed: only those rows offer Update
  // (updating an absent binary is the shelf's Install, not this surface's job).
  cliAvailability?: AgentCliAvailabilityMap
  // After a CLI update ran, the host force-reprobes availability so the row
  // reflects the binary the updater actually left behind.
  onCliUpdated?: () => void
  /**
   * Which primitives this mount is the inventory OF. The Extensions door's
   * three catalogues each show one — the Plugins view's Installed tab lists
   * MCP servers, Skills lists skills, Agent CLIs lists CLIs — because a tab
   * that says "Installed" beside "Plugins" must not answer with skills.
   * Omitted, every group renders, which is the whole-inventory mount.
   */
  kinds?: readonly ExtensionKind[]
  /**
   * Group by SOURCE rather than by kind (source-tabs ruling, 2026-09-05). The
   * receipts say which source installed what; `sources` gives each one its tab
   * name so the heading and the tab beside it read the same.
   */
  sourceGrouping?: { sources: readonly SkillSource[]; records: readonly InstalledPluginRecord[] }
  /** Walk the rows a page at a time, with the shared pager at the foot. */
  paging?: { noun: string; query?: string }
} & InventoryActions) {
  const [modules, setModules] = useState<LoadedSource<ThirdPartyModuleListResult>>({ status: 'loading' })
  const [skills, setSkills] = useState<LoadedSource<WorkspaceSkill[]>>({ status: 'loading' })
  const [clis, setClis] = useState<LoadedSource<PluginRegistryListEntry[]>>({ status: 'loading' })
  // null until the first read lands (or forever on a build predating the API):
  // no update claim either way. Never rendered as "up to date".
  const [updateStates, setUpdateStates] = useState<MarketplaceUpdateStatesResult | null>(null)
  const [updateRun, setUpdateRun] = useState<ModuleUpdateRun>({ status: 'idle' })
  const [updateNotice, setUpdateNotice] = useState<ModuleUpdateNotice | null>(null)
  const [updatingCliId, setUpdatingCliId] = useState<string | null>(null)
  const [cliNotice, setCliNotice] = useState<ModuleUpdateNotice | null>(null)

  const loadModules = useCallback(async () => {
    if (typeof window.api.listThirdPartyModules !== 'function') {
      setModules({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.listThirdPartyModules()
      // Guard the shape, not just the rejection: a malformed IPC result must
      // degrade to the error notice like every other source, never crash the
      // derive step (the state-matrix rule — MC-1847 E1).
      setModules(
        result && Array.isArray(result.modules) && Array.isArray(result.rejected)
          ? { status: 'ok', value: result }
          : { status: 'error', message: 'Could not list installed modules.' },
      )
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

  const loadSkills = useCallback(async () => {
    if (typeof window.api.workspaceSkillsList !== 'function') {
      setSkills({ status: 'unsupported' })
      return
    }
    if (!workspaceRoot) {
      setSkills({ status: 'unavailable', reason: 'Open a workspace to see the skills installed in it.' })
      return
    }
    try {
      const result = await window.api.workspaceSkillsList({ workspaceRoot })
      setSkills(result.ok ? { status: 'ok', value: result.skills } : { status: 'error', message: result.message })
    } catch (error) {
      setSkills({ status: 'error', message: errorMessage(error, 'Could not list installed skills.') })
    }
  }, [workspaceRoot])

  // Update detection (MC-1873). A thrown read is a failed check and renders
  // couldn't-check — never silence that reads as "up to date".
  const loadUpdateStates = useCallback(async (forceRefresh = false) => {
    if (typeof window.api.readMarketplacePluginUpdateStates !== 'function') return
    try {
      setUpdateStates(
        await window.api.readMarketplacePluginUpdateStates(forceRefresh ? { forceRefresh: true } : undefined),
      )
    } catch (error) {
      setUpdateStates({ ok: false, message: errorMessage(error, 'Could not check for updates.') })
    }
  }, [])

  useEffect(() => {
    void loadModules()
    void loadClis()
    void loadUpdateStates()
  }, [loadModules, loadClis, loadUpdateStates])

  // Skills are workspace-scoped, so re-list when the active workspace changes
  // (loadSkills closes over workspaceRoot).
  useEffect(() => {
    setSkills({ status: 'loading' })
    void loadSkills()
  }, [loadSkills])

  // After any update lands, the module list and the detection re-read together
  // so the banner and the row settle to current in one pass, no app restart.
  const settleAfterUpdate = useCallback(async () => {
    await Promise.all([loadModules(), loadUpdateStates(true)])
  }, [loadModules, loadUpdateStates])

  // Walk the pending updates one at a time. The pre-update verify re-runs
  // trust classification: a version now signed by a different key (or
  // unsigned where it was signed) pauses on the disclosure prompt or blocks —
  // never a silent grant. A block or error stops the walk; the banner still
  // names what remains. A trust grant re-enters the walk with `grant` set for
  // the entry the user just approved, skipping its second verify.
  const processUpdateQueue = useCallback(
    async (ids: string[], grant?: { id: string; pinnedRef: string | null }) => {
      let updated = false
      let pending = ids
      while (pending.length > 0) {
        const [id, ...rest] = pending
        pending = rest
        const entry = registryPlugins?.find((plugin) => plugin.id === id)
        if (
          !entry
          || typeof window.api.verifyMarketplacePlugin !== 'function'
          || typeof window.api.updateMarketplacePluginFromRegistry !== 'function'
        ) {
          setUpdateRun({ status: 'idle' })
          setUpdateNotice({
            tone: 'error',
            message: entry
              ? 'Updating extensions needs a newer app build. Update and restart.'
              : 'The marketplace entry for this update is not available right now.',
          })
          if (updated) await settleAfterUpdate()
          return
        }

        let trustGranted = false
        let pinnedRef: string | null = null
        if (grant?.id === id) {
          trustGranted = true
          pinnedRef = grant.pinnedRef
          grant = undefined
        } else {
          setUpdateRun({ status: 'busy', label: `Checking ${entry.name}…` })
          let verify
          try {
            verify = await window.api.verifyMarketplacePlugin(entry)
          } catch (error) {
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({ tone: 'error', message: errorMessage(error, 'Could not verify this update.') })
            if (updated) await settleAfterUpdate()
            return
          }
          const outcome = classifyVerification(verify, entry.provides)
          if (outcome.kind === 'blocked') {
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({
              tone: outcome.classification === 'invalid' ? 'error' : 'warn',
              message: outcome.message,
            })
            if (updated) await settleAfterUpdate()
            return
          }
          if (outcome.kind === 'needs-trust') {
            setUpdateRun({
              status: 'needs-trust',
              entry,
              queue: pending,
              permissions: outcome.permissions,
              files: outcome.files ?? null,
              pinnedRef: outcome.pinnedRef ?? null,
            })
            if (updated) await settleAfterUpdate()
            return
          }
        }

        setUpdateRun({ status: 'busy', label: `Updating ${entry.name}…` })
        try {
          const result = await window.api.updateMarketplacePluginFromRegistry({
            entry,
            trustGranted,
            workspaceRoot: workspaceRoot ?? undefined,
            mcpSettings,
            ...(pinnedRef ? { claudePluginRef: pinnedRef } : {}),
          })
          if (!result.ok) {
            const summary = summarizeInstallResult(result)
            setUpdateRun({ status: 'idle' })
            setUpdateNotice({
              tone: summary.status === 'blocked' && summary.classification === 'unsigned' ? 'warn' : 'error',
              message:
                summary.status === 'blocked' || summary.status === 'error'
                  ? summary.message
                  : 'The update could not be completed.',
            })
            await settleAfterUpdate()
            return
          }
          updated = true
          if (result.mcpSettings && actions.onUpsertMcpServer) {
            for (const server of Object.values(result.mcpSettings.servers)) actions.onUpsertMcpServer(server)
          }
          setUpdateNotice({ tone: 'good', message: `${entry.name} updated to v${result.version}.` })
        } catch (error) {
          setUpdateRun({ status: 'idle' })
          setUpdateNotice({ tone: 'error', message: errorMessage(error, 'The update could not be completed.') })
          await settleAfterUpdate()
          return
        }
      }
      setUpdateRun({ status: 'idle' })
      if (updated) await settleAfterUpdate()
    },
    [registryPlugins, workspaceRoot, mcpSettings, actions, settleAfterUpdate],
  )

  const startBannerUpdate = useCallback(
    (ids: string[]) => {
      setUpdateNotice(null)
      void processUpdateQueue(ids)
    },
    [processUpdateQueue],
  )

  // CLI half (owner-pinned): an Update action with no staleness detection —
  // the manifest update spec (the CLI's own updater where one exists, else an
  // idempotent re-run of the install). The outcome states what the updater
  // left behind; it never claims a newer version existed beforehand.
  const updateCli = useCallback(
    async (id: string) => {
      const name = (clis.status === 'ok' ? clis.value : []).find((plugin) => plugin.id === id)?.displayName ?? id
      if (typeof window.api.cliUpdate !== 'function') {
        setCliNotice({ tone: 'warn', message: 'Updating agent CLIs needs a newer app build. Update and restart.' })
        return
      }
      setUpdatingCliId(id)
      setCliNotice(null)
      try {
        const result = await window.api.cliUpdate(id)
        if (result.ok) {
          setCliNotice({
            tone: 'good',
            message: result.version ? `${name} is on ${result.version}.` : `${name} update finished.`,
          })
          onCliUpdated?.()
        } else {
          setCliNotice({ tone: 'error', message: result.error || `Could not update ${name}.` })
        }
      } catch (error) {
        setCliNotice({ tone: 'error', message: errorMessage(error, `Could not update ${name}.`) })
      } finally {
        setUpdatingCliId(null)
      }
    },
    [clis, onCliUpdated],
  )

  const banner = useMemo(
    () => deriveManageUpdateBanner(updateStates, cliOnlyRegistryIds(registryPlugins ?? [])),
    [updateStates, registryPlugins],
  )
  const updateFlow: ModuleUpdateFlow =
    updateRun.status === 'needs-trust'
      ? {
          status: 'needs-trust',
          tier: pluginTrust(updateRun.entry).tier,
          permissions: updateRun.permissions,
          files: updateRun.files,
        }
      : updateRun

  const view = deriveInstalledExtensions({
    mcpServers,
    modules,
    moduleOverrides,
    skills,
    clis,
  })

  return (
    <InstalledView
      view={view}
      kinds={kinds}
      sourceGrouping={sourceGrouping}
      paging={paging}
      actions={actions}
      registryPlugins={registryPlugins}
      skillUse={{ workspaceRoot, clis: clis.status === 'ok' ? clis.value : [] }}
      cliUpdate={{
        availability: cliAvailability,
        updatingId: updatingCliId,
        onUpdate: (id) => void updateCli(id),
        notice: cliNotice,
      }}
      moduleUpdateSlot={
        <ModuleUpdateBanner
          banner={banner}
          flow={updateFlow}
          notice={updateNotice}
          onUpdate={() => {
            if (banner.kind === 'updates') startBannerUpdate(banner.updates.map((update) => update.id))
          }}
          onTrustConfirm={() => {
            if (updateRun.status === 'needs-trust') {
              void processUpdateQueue([updateRun.entry.id, ...updateRun.queue], {
                id: updateRun.entry.id,
                pinnedRef: updateRun.pinnedRef,
              })
            }
          }}
          onCancelTrust={() => setUpdateRun({ status: 'idle' })}
        />
      }
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

// Context for the per-row CLI Update action: which binaries are really
// installed (only those rows offer it), the row currently updating, and the
// outcome line rendered under the group.
type CliUpdateContext = {
  availability?: AgentCliAvailabilityMap
  updatingId: string | null
  onUpdate: (id: string) => void
  notice: ModuleUpdateNotice | null
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
  kinds,
  sourceGrouping,
  paging,
  actions,
  skillUse,
  cliUpdate,
  registryPlugins,
  moduleUpdateSlot,
}: {
  view: ExtensionsInstalledView
  kinds?: readonly ExtensionKind[]
  sourceGrouping?: { sources: readonly SkillSource[]; records: readonly InstalledPluginRecord[] }
  paging?: { noun: string; query?: string }
  actions: InventoryActions
  skillUse: SkillUseContext
  cliUpdate?: CliUpdateContext
  registryPlugins?: MarketplacePluginEntry[]
  // The update banner (MC-1873): one calm line above the Capability modules
  // group — per the owner ruling it lives here and only here, never on rows,
  // never on the Skills surface.
  moduleUpdateSlot?: ReactNode
}) {
  // The page of a paged mount. Held here rather than by the caller because the
  // rows arrive here — over IPC, after the caller has already rendered — and a
  // page number owned by something that cannot see the rows is a number that
  // outlives them.
  const [position, setPosition] = useState({ key: '', page: 1 })
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-body text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading installed extensions…
      </div>
    )
  }

  if (view.status === 'unsupported') {
    return (
      <InlineNotice tone="warn">
        Installed extensions need a newer app build. Update and restart to see them here.
      </InlineNotice>
    )
  }

  // Degraded: zero rows but a source failed/was unavailable. Show only the
  // notices that explain why — never the "nothing installed" copy beneath them.
  if (view.status === 'degraded') {
    return <NoticeList notices={view.notices} />
  }

  const allGroups = view.status === 'ready' ? view.groups : []
  const kinded = kinds ? allGroups.filter((group) => kinds.includes(group.kind)) : allGroups
  // The search field in the chrome row says it filters the open tab, and
  // Installed is a tab: a field that visibly narrowed every other tab and left
  // this one alone would be the one place its own label is untrue.
  const needle = (paging?.query ?? '').trim().toLowerCase()
  const kindGroups = needle
    ? kinded
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            `${item.name} ${item.summary ?? ''} ${item.chips.join(' ')}`.toLowerCase().includes(needle),
          ),
        }))
        .filter((group) => group.items.length > 0)
    : kinded
  // Rows carry their kind, so a source-grouped mount still knows where the CLI
  // update line and the module banner belong.
  const kindsPresent = new Set(kindGroups.map((group) => group.kind))
  const groups = sourceGrouping
    ? groupInstalledBySource({
        rows: kindGroups.flatMap((group) => group.items),
        sources: sourceGrouping.sources,
        records: sourceGrouping.records,
      }).map((group) => ({ key: group.key, label: group.label, items: group.items }))
    : kindGroups.map((group) => ({ key: group.kind, label: group.label, items: group.items }))

  if (groups.length === 0) {
    return needle ? (
      <EmptyState density="list" title={`Nothing installed matches “${paging?.query?.trim() ?? ''}”.`} />
    ) : (
      <EmptyState
        density="list"
        title="Nothing installed yet."
        body="Get MCP servers, skills, agent CLIs and plugins from a source tab and they appear here."
      />
    )
  }

  const page = paging
    ? deriveCataloguePage({
        groups: groups.map((group) => ({ key: group.key, label: group.label, count: group.items.length })),
        page: stepCataloguePage(position, paging.query ?? '').page,
        pageSize: CATALOGUE_PAGE_SIZE,
        query: paging.query,
        noun: paging.noun,
      })
    : null
  const visible = page
    ? page.groups.map((slice) => {
        const group = groups.find((candidate) => candidate.key === slice.key)
        return {
          key: slice.key,
          label: slice.continued ? `${slice.label} (continued)` : slice.label,
          count: slice.total,
          kind: group?.items[0]?.kind,
          items: (group?.items ?? []).slice(slice.start, slice.end),
        }
      })
    : groups.map((group) => ({
        key: group.key,
        label: group.label,
        count: group.items.length,
        kind: group.items[0]?.kind,
        items: group.items,
      }))

  return (
    <div className="space-y-5">
      {view.status === 'ready' && view.notices.length > 0 ? <NoticeList notices={view.notices} /> : null}
      <div className="space-y-5">
        {visible.map((group) => (
          <section key={group.key} className="space-y-2">
            <ConnectorSectionHeading label={group.label} count={group.count} />
            {!sourceGrouping && group.kind === 'module' ? moduleUpdateSlot : null}
            {/* The Browse grid, row for row: two columns of the same card row
                the marketplace renders, so Installed reads as the same surface
                turned to face what is already here. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.items.map((item) => (
                <InstalledRow
                  key={item.key}
                  item={item}
                  actions={actions}
                  registryPlugins={registryPlugins}
                  skillUse={skillUse}
                  cliUpdate={cliUpdate}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {/* One line for the whole list, not one per group: the CLI updater's
          outcome and the module update banner are facts about the mount, and a
          source-grouped list has no single group to hang them on. */}
      {sourceGrouping && kindsPresent.has('module') ? moduleUpdateSlot : null}
      {kindsPresent.has('cli') && cliUpdate?.notice ? (
        cliUpdate.notice.tone === 'good' ? (
          <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
            <StatusDot tone="good" />
            <span>{cliUpdate.notice.message}</span>
          </div>
        ) : (
          <InlineNotice tone={cliUpdate.notice.tone}>{cliUpdate.notice.message}</InlineNotice>
        )
      ) : null}
      {page ? (
        <Pager
          page={page.page}
          pageCount={page.pageCount}
          rangeLabel={page.rangeLabel}
          onPageChange={(next) => setPosition({ key: paging?.query ?? '', page: next })}
          ariaLabel={`Installed ${paging?.noun ?? 'item'}s`}
        />
      ) : null}
    </div>
  )
}

// One inventory row on the shared ConnectorRow, exactly as Browse renders its
// entries: 36px icon chip · name + kind chip · human summary · plain-language
// status · actions. The forward actions (New chat, Use in agent, Update) are
// visible, as Browse's Add is; Remove is an icon action withheld until the row
// is pointed at or focused, so a grid of installed things does not read as a
// grid of delete buttons, and its reserved slot is one control wide rather
// than a word. Actions exist only where a real handler does.
function InstalledRow({
  item,
  actions,
  registryPlugins,
  skillUse,
  cliUpdate,
}: {
  item: InstalledExtension
  actions: InventoryActions
  registryPlugins?: MarketplacePluginEntry[]
  skillUse: SkillUseContext
  cliUpdate?: CliUpdateContext
}) {
  const registryEntry = item.kind === 'cli' ? registryPlugins?.find((plugin) => plugin.id === item.id) : undefined
  const launchable = item.kind === 'mcp' && item.enabled === true
  const cliUpdating = item.kind === 'cli' && cliUpdate?.updatingId === item.id

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
          onClick={() => actions.onLaunchConnector!({ id: item.id, name: item.name })}
        >
          New chat
        </PrimaryButton>,
      )
    }
    if (actions.onRemoveMcpServer) {
      rowActions.push(
        <RevealedAction key="remove">
          <Tooltip content="Remove" placement="top">
            <CloseIconButton onClick={() => actions.onRemoveMcpServer!(item.id)} aria-label={`Remove ${item.name}`} />
          </Tooltip>
        </RevealedAction>,
      )
    }
  } else if (item.kind === 'cli') {
    // Update with no version-delta claim (the owner-pinned CLI split: no
    // staleness detection — the label never says a newer version exists).
    // Offered only where the binary is really installed; an absent CLI's
    // affordance is the shelf's Install, not an update.
    if (cliUpdate && cliUpdate.availability?.[item.id]?.installed === true) {
      rowActions.push(
        <GhostButton
          key="update"
          size="sm"
          disabled={cliUpdate.updatingId !== null}
          onClick={() => cliUpdate.onUpdate(item.id)}
          className="border border-[color:var(--border-default)]"
          aria-label={`Update ${item.name}`}
        >
          {cliUpdating ? 'Updating…' : 'Update'}
        </GhostButton>,
      )
    }
  } else if (item.kind === 'skill') {
    if (skillUse.workspaceRoot) {
      rowActions.push(
        <UseSkillMenu
          key="use"
          skillId={item.id}
          name={item.name}
          skillUse={skillUse}
          onNewAgent={actions.onUseSkillInNewAgent}
        />,
      )
    }
    if (actions.onRemoveSkill) {
      rowActions.push(
        <RevealedAction key="remove">
          <Tooltip content="Remove" placement="top">
            <CloseIconButton onClick={() => actions.onRemoveSkill!(item.id)} aria-label={`Remove ${item.name}`} />
          </Tooltip>
        </RevealedAction>,
      )
    }
  }

  return (
    <ConnectorRow
      icon={
        item.kind === 'mcp' ? (
          <ExtensionIcon slug={mcpIconSlug(item.id)} name={item.name} size={36} />
        ) : (
          <PluginIcon
            iconUrl={registryEntry ? resolveIconUrl(actions.registryUrl ?? null, registryEntry.icon) : null}
            name={item.name}
            size={36}
          />
        )
      }
      name={item.name}
      summary={item.summary}
      chips={item.chips}
      status={
        item.kind === 'mcp' || (item.kind === 'module' && item.trust) ? <RowStatus item={item} /> : undefined
      }
      actions={rowActions.length > 0 ? rowActions : undefined}
    />
  )
}

// A row action withheld until the row is pointed at or focused (list-row): the
// slot keeps its width at rest so revealing never reflows, and it appears on
// keyboard focus as well as hover.
function RevealedAction({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100 opacity-0">
      {children}
    </span>
  )
}

// The row's decision-relevant status — trust for capability modules,
// active/inactive for MCP servers — as a StatusDot always paired with its text
// label, so status is never colour-only. Skills and CLIs have no such axis
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
        {/* A server its source has stopped declaring keeps working, so the
            active state still leads; the sentence after it is why Sync will not
            be refreshing it any more
            (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). */}
        {item.missingFromSource ? ` · ${NO_LONGER_IN_SOURCE}` : null}
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
  skillId,
  name,
  skillUse,
  onNewAgent,
}: {
  skillId: string
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

  // Focus enters the menu on open, on the first row that can take it — the
  // menu-button contract `OverflowMenu` and `SplitButton` keep. The rows here
  // arrive asynchronously (`sessions` is null while `terminalList()` is in
  // flight and the surface holds only the loading row), so on open there may be
  // nothing to focus yet. Park focus on the menu body itself in that case — it
  // carries the `roveMenuFocus` keydown handler, so the arrow keys are live —
  // and move onto row 1 the moment the rows exist.
  const menuBodyRef = useRef<HTMLDivElement | null>(null)
  const focusMenu = useCallback(() => {
    const body = menuBodyRef.current
    if (!body) return
    const first = body.querySelector<HTMLButtonElement>('[data-menu-item="true"]:not([disabled])')
    if (first) first.focus()
    else body.focus()
  }, [])
  // Stable identity: `Popover` keys its auto-focus effect on this callback.
  // Next frame, so the Popover has positioned (and un-hidden) its surface.
  const handleOpenAutoFocus = useCallback(() => {
    requestAnimationFrame(focusMenu)
  }, [focusMenu])
  useEffect(() => {
    if (!open || sessions === null) return
    const body = menuBodyRef.current
    if (!body) return
    // Do not steal focus back if it already sits on a row the person moved to.
    const active = document.activeElement
    if (active && active !== body && body.contains(active)) return
    const frame = requestAnimationFrame(focusMenu)
    return () => cancelAnimationFrame(frame)
  }, [open, sessions, focusMenu])

  // The row is a projection of the inventory record; the invocation machinery
  // needs the record itself (source, harnesses), re-read at click time so a
  // skill installed since the list loaded still resolves.
  const resolveSkill = async (): Promise<WorkspaceSkill | null> => {
    if (!skillUse.workspaceRoot) return null
    const result = await window.api.workspaceSkillsList({ workspaceRoot: skillUse.workspaceRoot })
    if (!result.ok) {
      setError(result.message)
      return null
    }
    return result.skills.find((skill) => skill.id === skillId) ?? null
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
      // The kit's list layer on the Popover's own `role="menu"` surface; the
      // rows are `MenuItem`, so arrow keys rove and a divider is the menu's own.
      surfaceClassName={`w-[240px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={handleOpenAutoFocus}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <OutlineButton ref={ref} size="sm" onClick={togglePopover} {...triggerProps}>
          Use in agent
        </OutlineButton>
      )}
    >
      <div
        ref={menuBodyRef}
        tabIndex={-1}
        className="flex flex-col outline-none"
        onKeyDown={(event) => roveMenuFocus(event, event.currentTarget.closest<HTMLElement>('[role="menu"]'))}
      >
        {error ? (
          <div className="px-2 pb-1">
            <InlineNotice tone="error">{error}</InlineNotice>
          </div>
        ) : null}
        {sessions === null ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-body text-[color:var(--text-muted)]" role="status">
            <Spinner size={14} />
            Finding running agents…
          </div>
        ) : (
          <>
            {sessions.length === 0 ? (
              <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">No running agents</div>
            ) : (
              sessions.map((session) => (
                <MenuItem
                  key={session.sessionId}
                  disabled={busy}
                  onClick={() => void insertIntoSession(session)}
                  trailing={
                    session.cli ? (
                      <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">{session.cli}</span>
                    ) : undefined
                  }
                >
                  {session.agentSession?.displayName ?? session.agentId ?? session.sessionId}
                </MenuItem>
              ))
            )}
            {onNewAgent ? (
              <>
                <MenuDivider />
                <MenuItem disabled={busy} onClick={() => void startNewAgent()}>
                  New agent…
                </MenuItem>
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
