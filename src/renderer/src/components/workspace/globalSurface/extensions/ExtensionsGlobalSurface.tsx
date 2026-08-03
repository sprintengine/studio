// The Extensions door (MC-1847, variant A "catalog rail" from
// backlog/mockups/2026-07-23-extensions-door.html): the connectors modal's
// browse/install/launch experience as a door-routed full-page surface, on the
// same GlobalSurfaceShell + SurfaceRail substrate as the other five doors. The
// rail navigates the marketplace by kind (a Marketplace group) and the manage
// half (an "On this machine" group); the canvas is the shared
// ConnectorsBrowseCanvas / ConnectorsManage the modal renders — one
// implementation, relocated. Host actions (New chat, Use in automation, Use in
// agent) route through the extensionsSurfaceHost seam WorkspaceManager fills.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { AutomationDefinition } from '../../../../../../shared/automations/contracts'
import type { WorkspaceSkill } from '../../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../agentComposer/AgentComposer'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { McpGlyph, SkillsGlyph } from '../../../ui/CapabilityGlyphs'
import { automationsDoorTarget } from '../../../automations/runTarget'
import { dispatchAutomationSurfaceTarget } from '../automations/automationSurfaceTarget'
import { AutomationServerSettings } from '../../../settings/AutomationServerSettings'
import {
  ConnectorsBrowseCanvas,
  useConnectorsBrowseState,
} from '../../../panels/ConnectorsPanel/ConnectorsBrowseCanvas'
import { ConnectorsManage } from '../../../panels/ConnectorsPanel/ConnectorsManage'
import { ExtensionKindCanvas, type CliShelfRuntime } from '../../../panels/ConnectorsPanel/ExtensionKindCanvas'
import {
  buildConnectorEntries,
  launchableConnectors,
  registryEntriesForKinds,
} from '../../../panels/ConnectorsPanel/connectorsFacets'
import { useConnectorSources } from '../../../panels/ConnectorsPanel/useConnectorSources'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { SurfaceRail, type SurfaceRailGroup } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import { getExtensionsSurfaceHost } from './extensionsSurfaceHost'
import { SkillsSurface } from './skills/SkillsSurface'
import { deriveSkillsKindStateLine } from './skills/skillsSurfaceModel'
import { useSkillSources } from './skills/useSkillSources'
import {
  consumePendingExtensionsSurfaceTarget,
  subscribeExtensionsSurfaceTarget,
  type ExtensionsSurfaceView,
} from './extensionsSurfaceTarget'

// The canvas sections. The connector marketplace is ONE section with ONE
// browse state: its two rail rows (Featured, MCP servers) are projections of
// the canvas's facet — selecting a row sets the facet, and changing the facet
// tab moves the rail highlight — so the rail and the facet tabs can never
// contradict each other. Skills owns its own sources and their nested rail;
// Automations, Modules and Agent CLIs are kind canvases over the registry
// (MC-1847 C2, MC-2034).
type ExtensionsSection =
  | 'marketplace'
  | 'skills'
  | 'automations'
  | 'modules'
  | 'agent-clis'
  | 'installed'
  | 'automation-server'

export default function ExtensionsGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  // The CLI an agent-backed automation falls back to when its own config names
  // none. Only app settings hold it and the shelf's canvas is store-free, so the
  // door reads it and hands it down — an install that needs it and cannot get it
  // is refused rather than creating a job that fails at 02:00.
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
  const sources = useConnectorSources(activeWorkspaceRoot)

  // The Agent CLIs canvas shows runtime state (MC-1858): the door reads the
  // existing detection stack — the availability slice and the plugin catalog —
  // and hands it down so the canvas stays store-free. No second mechanism.
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliAvailabilityError = useWorkspaceStore((s) => s.cliAvailabilityError)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const cliShelfRuntime = useMemo<CliShelfRuntime>(
    () => ({
      platform: window.api.platform,
      availability: cliAvailability,
      availabilityStatus: cliAvailabilityStatus,
      availabilityError: cliAvailabilityError,
      catalogEntries: pluginCatalogEntries,
      catalogStatus: pluginCatalogStatus,
      cliRuntimes,
      refreshAvailability: refreshCliAvailability,
      refreshCatalog: refreshPluginCatalog,
      setCliRuntime,
    }),
    [
      cliAvailability,
      cliAvailabilityStatus,
      cliAvailabilityError,
      pluginCatalogEntries,
      pluginCatalogStatus,
      cliRuntimes,
      refreshCliAvailability,
      refreshPluginCatalog,
      setCliRuntime,
    ],
  )

  const [section, setSection] = useState<ExtensionsSection>('marketplace')
  // The door lands on Featured (the launchable connectors); the facet doubles
  // as the marketplace rail-row selection.
  const browse = useConnectorsBrowseState('Featured')
  const { facet, setFacet } = browse
  // Skill sources are read here, not inside the Skills canvas, so the rail row
  // states the same counts the surface does instead of a second opinion.
  const skillSources = useSkillSources(activeWorkspaceRoot)

  const applyTargetView = useCallback(
    (view: ExtensionsSurfaceView) => {
      if (view === 'installed' || view === 'skills') {
        setSection(view)
        return
      }
      // The old modal's Browse deep-link landed on the full grid, not Featured.
      setSection('marketplace')
      setFacet('All')
    },
    [setFacet],
  )

  // Deep-link: drain the latch on mount and subscribe live (the automations
  // surface-target idiom), so entry points land on the right rail row whether
  // the door was already open or just mounted.
  useEffect(() => {
    const pending = consumePendingExtensionsSurfaceTarget()
    if (pending) applyTargetView(pending)
    return subscribeExtensionsSurfaceTarget((view) => {
      consumePendingExtensionsSurfaceTarget()
      applyTargetView(view)
    })
  }, [applyTargetView])

  // Host actions, read at call time from the seam WorkspaceManager fills. A
  // missing host (tests, detached mounts) no-ops rather than throwing.
  const launchConnector = useCallback((connector: AgentComposerConnector) => {
    getExtensionsSurfaceHost()?.onLaunchConnector(connector)
  }, [])
  const useInAutomation = useCallback((serverId: string) => {
    getExtensionsSurfaceHost()?.onUseInAutomation(serverId)
  }, [])
  const useSkillInNewAgent = useCallback((skill: WorkspaceSkill) => {
    getExtensionsSurfaceHost()?.onUseSkillInNewAgent(skill)
  }, [])

  // An automation already in this project is opened where it is configured, not
  // here: leave this door and land the Automations door on that automation. The
  // deep-link seam is the one automations already use (a run notification's
  // Open), with no run to focus — the surface selects the automation and the
  // empty run id focuses nothing.
  const openAutomation = useCallback(
    (definition: AutomationDefinition) => {
      dispatchAutomationSurfaceTarget(automationsDoorTarget(definition.id, '', activeWorkspaceRoot))
      openGlobalSurface('automations')
    },
    [activeWorkspaceRoot, openGlobalSurface],
  )

  // A Get lands the same way, one step further in: the automation the shelf just
  // added arrives selected AND open in its editor, because the shelf configures
  // nothing and this is the only place a starter is tailored (MC-2035). Same
  // deep-link seam, same door — only the view differs, so there is no second way
  // to address an automation.
  const tailorAddedAutomation = useCallback(
    (automationId: string) => {
      dispatchAutomationSurfaceTarget(automationsDoorTarget(automationId, '', activeWorkspaceRoot), 'editor')
      openGlobalSurface('automations')
    },
    [activeWorkspaceRoot, openGlobalSurface],
  )

  // ── Counts for the bar + rail state lines (honest per source state) ────────
  const catalog = sources.catalogLoad.status === 'ready' ? sources.catalogLoad.data : []
  const plugins = sources.registryLoad.status === 'ready' ? sources.registryLoad.data : []
  const catalogReady = sources.catalogLoad.status === 'ready'
  const registryReady = sources.registryLoad.status === 'ready'
  // The launchable population is valid once the catalog stops loading: on a
  // catalog error it truthfully degrades to the installed servers, which
  // launch without the catalog (the browse canvas discloses the failure).
  const catalogSettled = sources.catalogLoad.status !== 'loading'
  const marketplaceLoading =
    sources.catalogLoad.status === 'loading' || sources.registryLoad.status === 'loading'
  const marketplaceDown = !marketplaceLoading && !catalogReady && !registryReady

  const readyCount = useMemo(
    () => launchableConnectors(catalog, sources.mcpSettings.servers).length,
    [catalog, sources.mcpSettings.servers],
  )
  const marketplaceCount = useMemo(
    () => buildConnectorEntries(catalog, plugins, sources.installedServerIds).length,
    [catalog, plugins, sources.installedServerIds],
  )
  const automationCount = useMemo(() => registryEntriesForKinds(plugins, ['automation']).length, [plugins])
  const moduleCount = useMemo(() => registryEntriesForKinds(plugins, ['module']).length, [plugins])
  const cliCount = useMemo(() => registryEntriesForKinds(plugins, ['cli']).length, [plugins])
  const installedCount = sources.installedServerIds.size

  // The registry alone feeds the module/cli rows; the Skills row reads its own
  // sources. Same honesty rule as the marketplace row: loading and unavailable
  // never render as a zero count.
  const registryStateLine = (count: number): string =>
    sources.registryLoad.status === 'loading'
      ? 'Loading…'
      : sources.registryLoad.status === 'error'
        ? 'Marketplace unavailable'
        : `${count} available`
  const skillsStateLine = deriveSkillsKindStateLine(
    skillSources.sourcesLoad,
    skillSources.sources,
    skillSources.scans,
  )

  // ── Bar ────────────────────────────────────────────────────────────────────
  // The name, and nothing else. The counts it used to carry are each already on
  // the rail row that owns them ("MCP servers · 318 available", "Installed · 1
  // active MCP server"), so in the bar they were the same numbers a second time.
  const bar: GlobalSurfaceBar = { title: 'Extensions' }

  // ── Rail ───────────────────────────────────────────────────────────────────
  const marketplaceStateLine = marketplaceLoading
    ? 'Loading…'
    : marketplaceDown
      ? 'Marketplace unavailable'
      : `${marketplaceCount} available`

  const groups: SurfaceRailGroup[] = [
    {
      key: 'marketplace',
      label: 'Marketplace',
      rows: [
        {
          id: 'featured',
          title: 'Featured',
          stateLine: catalogSettled ? `${readyCount} ready to launch` : 'Loading…',
          icon: <FeaturedGlyph />,
        },
        {
          id: 'mcp-servers',
          title: 'MCP servers',
          stateLine: marketplaceStateLine,
          icon: <McpGlyph />,
        },
        {
          id: 'skills',
          title: 'Skills',
          stateLine: skillsStateLine,
          icon: <SkillsGlyph />,
        },
        // Order follows MARKETPLACE_COMPONENT_KINDS, so the shelf reads in the
        // same order the kind set is declared in.
        {
          id: 'automations',
          title: 'Automations',
          stateLine: registryStateLine(automationCount),
          icon: <AutomationGlyph />,
        },
        {
          id: 'modules',
          title: 'Modules',
          stateLine: registryStateLine(moduleCount),
          icon: <ModuleGlyph />,
        },
        {
          id: 'agent-clis',
          title: 'Agent CLIs',
          stateLine: registryStateLine(cliCount),
          icon: <CliGlyph />,
        },
      ],
    },
    {
      key: 'machine',
      label: 'On this machine',
      rows: [
        {
          id: 'installed',
          title: 'Installed',
          stateLine:
            installedCount > 0
              ? `${installedCount} active MCP server${installedCount === 1 ? '' : 's'}`
              : 'MCPs, skills, CLIs, modules',
          icon: <InstalledGlyph />,
        },
        {
          id: 'automation-server',
          title: 'Automation server',
          stateLine: 'Agent-triggered automations',
          icon: <AutomationServerGlyph />,
        },
      ],
    },
  ]
  const rows = groups.flatMap((group) => group.rows)

  // The marketplace rows project the facet: Featured is selected exactly while
  // the Featured facet is active; any other facet highlights MCP servers.
  const selectedRailId =
    section === 'marketplace' ? (facet === 'Featured' ? 'featured' : 'mcp-servers') : section

  const onRailSelect = useCallback(
    (id: string) => {
      if (id === 'featured') {
        setSection('marketplace')
        setFacet('Featured')
        return
      }
      if (id === 'mcp-servers') {
        setSection('marketplace')
        // Leaving Featured lands on the full grid; a non-Featured facet the
        // user already picked survives the round-trip.
        if (facet === 'Featured') setFacet('All')
        return
      }
      setSection(id as ExtensionsSection)
    },
    [facet, setFacet],
  )

  const rail = (
    <SurfaceRail
      label="Extensions"
      rows={rows}
      groups={groups}
      selectedId={selectedRailId}
      onSelect={onRailSelect}
      // The custom-MCP form lives at the top of the Installed canvas; the
      // affordance lands the user right on it.
      newAffordance={{ label: 'Add a custom MCP', onActivate: () => setSection('installed') }}
    />
  )

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const canvas = (() => {
    switch (section) {
      case 'marketplace':
        return (
          <ConnectorsBrowseCanvas
            sources={sources}
            state={browse}
            workspaceRoot={activeWorkspaceRoot}
            onLaunchConnector={launchConnector}
            onUseInAutomation={useInAutomation}
          />
        )
      case 'skills':
        return (
          <SkillsSurface
            sources={skillSources}
            workspaceRoot={activeWorkspaceRoot}
            onBrowseMcpServers={() => {
              setSection('marketplace')
              setFacet('All')
            }}
            // Discover's code search needs a GitHub token, which is configured
            // in Settings; the door owns the store, so the surface stays
            // store-free and takes the route as a prop.
            onConfigureGitHubToken={() => openSettingsOverlay({ initialTab: 'github' })}
          />
        )
      case 'automations':
        return (
          <ExtensionKindCanvas
            kind="automation"
            sources={sources}
            workspaceRoot={activeWorkspaceRoot}
            automationDefaultCli={lastSelectedCli}
            onOpenAutomation={openAutomation}
            onAutomationAdded={tailorAddedAutomation}
          />
        )
      case 'modules':
        return <ExtensionKindCanvas kind="module" sources={sources} workspaceRoot={activeWorkspaceRoot} />
      case 'agent-clis':
        return (
          <ExtensionKindCanvas
            kind="cli"
            sources={sources}
            workspaceRoot={activeWorkspaceRoot}
            cliRuntime={cliShelfRuntime}
          />
        )
      case 'installed':
        return (
          <ConnectorsManage
            activeWorkspaceRoot={activeWorkspaceRoot}
            catalogServers={catalog}
            registryPlugins={plugins}
            onLaunchConnector={launchConnector}
            onUseInAutomation={useInAutomation}
            onUseSkillInNewAgent={useSkillInNewAgent}
          />
        )
      case 'automation-server':
        return <AutomationServerSettings />
    }
  })()

  return (
    <GlobalSurfaceShell
      ariaLabel="Extensions"
      bar={bar}
      rail={rail}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      {/* Each section remounts its scroll container so scroll position never
          leaks between sections; browse state itself persists above, and the
          Featured ↔ MCP servers switch is a facet change inside one mounted
          canvas, not a remount. Skills brings its own nested rail and scrolls
          beside it, so it takes the region whole rather than sitting inside
          this padded scrollport. */}
      {section === 'skills' ? (
        <div key={section} className="h-full min-h-0">
          {canvas}
        </div>
      ) : (
        <div key={section} className="h-full min-h-0 overflow-y-auto px-5 py-4">
          {canvas}
        </div>
      )}
    </GlobalSurfaceShell>
  )
}

// Rail row glyphs — quiet 12px type marks in the muted ink, matching the rail's
// no-tone-dot ruling (the state line carries the words).

function FeaturedGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path
        d="M8 2.2l1.8 3.6 4 .6-2.9 2.8.7 4L8 11.3 4.4 13.2l.7-4L2.2 6.4l4-.6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function InstalledGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A clock hand sweeping into a branch: a job that fires on a schedule and lands
// on its own branch. Distinct from the automation-server glyph's plain clock,
// which is a listening endpoint rather than a scheduled job.
function AutomationGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path
        d="M4 2.8v4.4a2 2 0 0 0 2 2h5.2M11.8 2.8v10.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4" cy="2.8" r="1.3" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.8" cy="13.2" r="1.3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function ModuleGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path
        d="M8 2 13.5 4.6v6L8 13.9 2.5 10.6v-6zM2.5 4.6 8 7.2l5.5-2.6M8 7.2v6.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CliGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path
        d="M2.5 3.5h11v9h-11zM4.8 6.6l2 1.7-2 1.7M8.6 10.3h2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AutomationServerGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3l2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
