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

import type { WorkspaceSkill } from '../../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../agentComposer/AgentComposer'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { AutomationServerSettings } from '../../../settings/AutomationServerSettings'
import {
  ConnectorsBrowseCanvas,
  useConnectorsBrowseState,
} from '../../../panels/ConnectorsPanel/ConnectorsBrowseCanvas'
import { ConnectorsManage } from '../../../panels/ConnectorsPanel/ConnectorsManage'
import {
  buildConnectorEntries,
  launchableConnectors,
} from '../../../panels/ConnectorsPanel/connectorsFacets'
import { useConnectorSources } from '../../../panels/ConnectorsPanel/useConnectorSources'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { BarStatusChip, SurfaceRail, type SurfaceRailGroup } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import { getExtensionsSurfaceHost } from './extensionsSurfaceHost'
import {
  consumePendingExtensionsSurfaceTarget,
  subscribeExtensionsSurfaceTarget,
  type ExtensionsSurfaceView,
} from './extensionsSurfaceTarget'

// Rail rows. Marketplace kinds first (Featured, the full grid), then the
// manage half. Skill packs / Modules / Agent CLIs join the Marketplace group
// in C2 of the epic.
type ExtensionsRailId = 'featured' | 'mcp-servers' | 'installed' | 'automation-server'

// The old modal's two deep-link destinations, mapped onto rail rows: browse →
// the full marketplace grid, installed → the manage view.
function railIdForTargetView(view: ExtensionsSurfaceView): ExtensionsRailId {
  return view === 'installed' ? 'installed' : 'mcp-servers'
}

export default function ExtensionsGlobalSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const sources = useConnectorSources(activeWorkspaceRoot)

  const [selectedId, setSelectedId] = useState<ExtensionsRailId>('featured')
  // Browse state per marketplace row, held here so switching rows (or visiting
  // Installed) and coming back keeps each row's search/facet/detail.
  const featuredBrowse = useConnectorsBrowseState('Featured')
  const allBrowse = useConnectorsBrowseState('All')

  // Deep-link: drain the latch on mount and subscribe live (the automations
  // surface-target idiom), so entry points land on the right rail row whether
  // the door was already open or just mounted.
  useEffect(() => {
    const pending = consumePendingExtensionsSurfaceTarget()
    if (pending) setSelectedId(railIdForTargetView(pending))
    return subscribeExtensionsSurfaceTarget((view) => {
      consumePendingExtensionsSurfaceTarget()
      setSelectedId(railIdForTargetView(view))
    })
  }, [])

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

  // ── Counts for the bar + rail state lines ──────────────────────────────────
  const catalog = sources.catalogLoad.status === 'ready' ? sources.catalogLoad.data : []
  const plugins = sources.registryLoad.status === 'ready' ? sources.registryLoad.data : []
  const settled = sources.catalogLoad.status !== 'loading' && sources.registryLoad.status !== 'loading'

  const readyCount = useMemo(
    () => launchableConnectors(catalog, sources.mcpSettings.servers).length,
    [catalog, sources.mcpSettings.servers],
  )
  const marketplaceCount = useMemo(
    () => buildConnectorEntries(catalog, plugins, sources.installedServerIds).length,
    [catalog, plugins, sources.installedServerIds],
  )
  const installedCount = sources.installedServerIds.size

  // ── Bar ────────────────────────────────────────────────────────────────────
  const bar: GlobalSurfaceBar = {
    title: 'Connectors',
    // Status is earned: the chip appears only when something is launchable.
    statusChip:
      readyCount > 0 ? (
        <BarStatusChip tone="good" label={`${readyCount} ready to launch`} />
      ) : undefined,
    contextSub: settled ? `${marketplaceCount} in marketplace · ${installedCount} installed` : undefined,
  }

  // ── Rail ───────────────────────────────────────────────────────────────────
  const groups: SurfaceRailGroup[] = [
    {
      key: 'marketplace',
      label: 'Marketplace',
      rows: [
        {
          id: 'featured',
          title: 'Featured',
          stateLine: settled ? `${readyCount} ready to launch` : 'Loading…',
          icon: <FeaturedGlyph />,
        },
        {
          id: 'mcp-servers',
          title: 'MCP servers',
          stateLine: settled ? `${marketplaceCount} available` : 'Loading…',
          icon: <McpGlyph />,
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

  const rail = (
    <SurfaceRail
      label="Connectors"
      rows={rows}
      groups={groups}
      selectedId={selectedId}
      onSelect={(id) => setSelectedId(id as ExtensionsRailId)}
      // The custom-MCP form lives at the top of the Installed canvas; the
      // affordance lands the user right on it.
      newAffordance={{ label: 'Add a custom MCP', onActivate: () => setSelectedId('installed') }}
    />
  )

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const canvas = (() => {
    switch (selectedId) {
      case 'featured':
      case 'mcp-servers': {
        const state = selectedId === 'featured' ? featuredBrowse : allBrowse
        return (
          <ConnectorsBrowseCanvas
            sources={sources}
            state={state}
            workspaceRoot={activeWorkspaceRoot}
            onLaunchConnector={launchConnector}
            onUseInAutomation={useInAutomation}
          />
        )
      }
      case 'installed':
        return (
          <ConnectorsManage
            activeWorkspaceRoot={activeWorkspaceRoot}
            catalogServers={catalog}
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
      ariaLabel="Connectors"
      bar={bar}
      rail={rail}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      {/* Each rail row remounts its scroll container so scroll position never
          leaks between rows; the browse state itself persists above. */}
      <div key={selectedId} className="h-full min-h-0 overflow-y-auto px-5 py-4">
        {canvas}
      </div>
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

function McpGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <path
        d="M5.5 2v3M10.5 2v3M4 5h8v3.5a4 4 0 0 1-8 0zM8 12.5V14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
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

function AutomationServerGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3l2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
