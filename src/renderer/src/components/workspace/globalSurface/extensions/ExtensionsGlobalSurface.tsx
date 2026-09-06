// The Extensions door: three catalogues behind one surface id.
//
// Source-tabs ruling (2026-09-05). The door used to be a rail of seven rows —
// Featured, Plugins, MCP servers, Skills, Automations, Modules, Agent CLIs —
// over a canvas per row. It is three views now, each the same page:
//
//   Plugins · Skills · Agent CLIs
//
// and the things that left are each somewhere better: the Automations shelf's
// five built-ins are the Automations surface's "Built in" list, Modules are
// switches in Settings → Modules (they were offered in two shapes on two
// surfaces), the automation server is a Settings concern rather than a
// catalogue row, and Featured ranked the catalogue by a fact about the machine.
//
// What this file owns is what the three views SHARE and nothing else: the
// reads (the MCP catalogue, the marketplace registry, the sources and their
// scans), the two ways a source is added, which view the drawer is standing on,
// and the tab that view is on — because the ruling says the chosen source
// survives a switch between Plugins and Skills.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { McpServerConfig, WorkspaceSkill } from '../../../../../../shared/electron-api'
import type { SkillHarness, SkillSource } from '../../../../../../shared/skills'
import { SKILL_PACK_HARNESSES } from '../../../../../../shared/skill-harnesses'
import type { AgentComposerConnector } from '../../agentComposer/AgentComposer'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { CliShelfRuntime } from '../../../panels/ConnectorsPanel/AgentCliShelfRows'
import { useConnectorSources } from '../../../panels/ConnectorsPanel/useConnectorSources'
import { getExtensionsSurfaceHost } from './extensionsSurfaceHost'
import { AgentClisCatalogue } from './clis/AgentClisCatalogue'
import { PluginsCatalogue } from './plugins/PluginsCatalogue'
import { AddSkillSourceModal } from './skills/AddSkillSourceModal'
import { SkillsCatalogue } from './skills/SkillsCatalogue'
import { useSkillSources } from './skills/useSkillSources'
import { INSTALLED_TAB_ID } from './catalogue/catalogueTabs'
import {
  consumePendingExtensionsSurfaceTarget,
  subscribeExtensionsSurfaceTarget,
  EXTENSIONS_DRAWER_VIEWS,
  type ExtensionsDrawerView,
  type ExtensionsSurfaceTarget,
} from './extensionsSurfaceTarget'
import { publishSurfaceView } from '../../surfaceView'

export default function ExtensionsGlobalSurface(): JSX.Element {
  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.folderPath ?? null,
  )
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const connectors = useConnectorSources(activeWorkspaceRoot)
  const sources = useSkillSources(activeWorkspaceRoot)

  // The Agent CLIs catalogue shows runtime state (MC-1858): the door reads the
  // existing detection stack — the availability slice and the plugin catalog —
  // and hands it down so the catalogue stays store-free. No second mechanism.
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

  // The harness directories a plugin's skills fan out to: the shared `.agents`
  // dir plus every natively skill-capable CLI this machine has — the
  // main-process rule (skill-harness-targets.ts), read from the detection the
  // door already holds so the pane can say what will land where.
  const harnesses = useMemo<SkillHarness[]>(() => {
    const wanted = new Set<SkillHarness>(['agents'])
    for (const entry of pluginCatalogEntries) {
      if (entry.skillIntegration?.support !== 'native') continue
      if (cliAvailability[entry.id]?.installed !== true) continue
      const harness = entry.skillIntegration.harnessId as SkillHarness
      if (SKILL_PACK_HARNESSES.includes(harness)) wanted.add(harness)
    }
    return SKILL_PACK_HARNESSES.filter((harness) => wanted.has(harness))
  }, [pluginCatalogEntries, cliAvailability])

  const [view, setView] = useState<ExtensionsDrawerView>(EXTENSIONS_DRAWER_VIEWS.plugins)
  // The open tab, held ACROSS views: Installed, or a source id. The ruling asks
  // that the chosen source survive a switch between Plugins and Skills, and a
  // source id is what "the chosen source" is — so one piece of state answers
  // both "which tab" and "which source".
  const [tabId, setTabId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // The repository the Add-from-GitHub modal opens on ('' for an empty field).
  const [addRepo, setAddRepo] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const applyTarget = useCallback((target: ExtensionsSurfaceTarget) => {
    setView(target.view)
    setQuery('')
    if (target.installed) setTabId(INSTALLED_TAB_ID)
  }, [])

  // Deep-link: drain the latch on mount and subscribe live (the automations
  // surface-target idiom), so entry points land on the right view whether the
  // door was already open or just mounted.
  useEffect(() => {
    const pending = consumePendingExtensionsSurfaceTarget()
    if (pending) applyTarget(pending)
    return subscribeExtensionsSurfaceTarget((target) => {
      consumePendingExtensionsSurfaceTarget()
      applyTarget(target)
    })
  }, [applyTarget])

  // Say which of the Extensions drawer's rows this surface is standing on
  // (drawer ruling, 2026-09-05), so exactly one of Plugins / Skills / Agent
  // CLIs reads selected.
  useEffect(() => {
    publishSurfaceView('extensions', view)
  }, [view])
  // Closing takes the selection with it: a drawer row must not stay lit over a
  // card region the surface no longer owns. Deliberately its OWN effect with an
  // empty dep list — as the cleanup of the publish above it, it ran on every
  // in-surface move, publishing `null` and then the new view in one commit, and
  // the drawer's selected row blinked off and back on every time.
  useEffect(() => () => publishSurfaceView('extensions', null), [])

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

  const addMcpServers = useCallback(
    (servers: McpServerConfig[]) => {
      for (const server of servers) connectors.upsertMcpServer(server)
    },
    [connectors],
  )
  const removeMcpServers = useCallback(
    (serverIds: string[]) => {
      for (const id of serverIds) removeMcpServer(id)
    },
    [removeMcpServer],
  )

  const openAddedSource = useCallback((source: SkillSource) => {
    sources.refreshSources()
    setTabId(source.id)
    setQuery('')
  }, [sources])

  /**
   * "Add from file…": a folder on this machine. The picker is the app's own
   * open-folder dialog, and the scan is the same rule a repository gets — the
   * source kind differs, the reading does not.
   */
  const addFromFile = useCallback(async (): Promise<void> => {
    setAddError(null)
    if (typeof window.api.skillsAddLocalSource !== 'function') {
      setAddError('Adding a folder needs a newer app build. Update and restart.')
      return
    }
    const path = await window.api.openDir()
    if (!path) return
    const result = await window.api.skillsAddLocalSource({ path, replace: true })
    if (!result.ok) {
      setAddError(result.message)
      return
    }
    openAddedSource(result.source)
  }, [openAddedSource])

  const add = useMemo(
    () => ({ onAddFromFile: () => void addFromFile(), onAddFromGitHub: () => setAddRepo('') }),
    [addFromFile],
  )

  const selectTab = useCallback((next: string) => {
    setTabId(next)
    setQuery('')
  }, [])

  return (
    <>
      {view === EXTENSIONS_DRAWER_VIEWS.skills ? (
        <SkillsCatalogue
          sources={sources}
          workspaceRoot={activeWorkspaceRoot}
          activeTabId={tabId}
          onSelectTab={selectTab}
          query={query}
          onQueryChange={setQuery}
          add={add}
          addNotice={addError}
          onDismissAddNotice={() => setAddError(null)}
          onUseSkillInNewAgent={useSkillInNewAgent}
        />
      ) : view === EXTENSIONS_DRAWER_VIEWS.agentClis ? (
        <AgentClisCatalogue
          sources={sources}
          connectors={connectors}
          workspaceRoot={activeWorkspaceRoot}
          cliRuntime={cliShelfRuntime}
          activeTabId={tabId}
          onSelectTab={selectTab}
          query={query}
          onQueryChange={setQuery}
        />
      ) : (
        <PluginsCatalogue
          sources={sources}
          connectors={connectors}
          workspaceRoot={activeWorkspaceRoot}
          harnesses={harnesses}
          activeTabId={tabId}
          onSelectTab={selectTab}
          query={query}
          onQueryChange={setQuery}
          add={add}
          addNotice={addError}
          onDismissAddNotice={() => setAddError(null)}
          onAddMcpServers={addMcpServers}
          onRemoveMcpServers={removeMcpServers}
          onLaunchConnector={launchConnector}
          onUseInAutomation={useInAutomation}
        />
      )}
      <AddSkillSourceModal
        open={addRepo !== null}
        initialRepo={addRepo ?? ''}
        addedRepos={sources.sources.map((source) => source.repo)}
        onClose={() => setAddRepo(null)}
        onAdded={openAddedSource}
        onRemoved={() => sources.refreshSources()}
        onConfigureGitHubToken={() => openSettingsOverlay({ initialTab: 'github' })}
      />
    </>
  )
}
