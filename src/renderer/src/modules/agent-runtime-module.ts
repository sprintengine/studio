import React from 'react'

import type { RendererModule } from './renderer-host'
import {
  agentLinkForItem,
  hasAgentLink,
  openAgentBacklogLink,
  resolveAgentBacklogLink,
  AGENT_RUNTIME_MODULE_ID,
  AGENT_TERMINAL_TARGET_KIND,
  type AgentBacklogLinkOpenPorts,
} from '../utils/agentBacklogLinks'
import { consumePendingExtensionsSurfaceTarget } from '../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { PluginsGlyph } from '../components/workspace/modalSurfaceGlyphs'

// The Plugins surface (MC-1847's Extensions door until doors→modals,
// 2026-09-01): the connectors browse/install/launch experience, now mounted in
// the shell's modal shell. Lazy — and deliberately NOT a top-level import —
// because the surface reaches the workspace store; keeping it behind a dynamic
// import leaves the eager module-registry graph store-free, the discipline the
// other surfaces follow. The glyph and the latch drainer ARE eager, and both
// are store-free leaves.
const ExtensionsGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/extensions/ExtensionsGlobalSurface')
)

// Activate the agent's workspace, then focus (or add) its terminal tab. The
// mounted model is tried first; if the workspace was just activated and its
// model isn't mounted yet, the persisted layout model is mutated so the tab is
// present on mount.
async function agentBacklogOpenPorts(): Promise<AgentBacklogLinkOpenPorts> {
  const [{ useWorkspaceStore }, { publishDiagnostic }, { focusOrAddAgentTab, ensureAgentTabInLayoutModel, flashAgentTab }, { findWorkspaceForAgentPreferring }] =
    await Promise.all([
      import('../store/workspaceStore'),
      import('../utils/diagnostics'),
      import('../utils/modelRegistry'),
      import('../utils/agentLocation'),
    ])
  return {
    focusAgent: ({ agentId, agentName, preferredWorkspaceId }) => {
      const store = useWorkspaceStore.getState()
      // Live lookup, preferring the workspace the link recorded: a shared id like
      // `agent-1` must land on its own workspace, not the first other workspace
      // that also has an `agent-1`. The global scan is the moved-agent fallback.
      const workspace = findWorkspaceForAgentPreferring(store.workspaces, agentId, preferredWorkspaceId)
      if (!workspace) return false
      store.setActiveWorkspace(workspace.id)
      // Flash the green spawn border so the user can see *which* terminal was
      // revealed when several share a tab strip. focusOrAddAgentTab only selects
      // an already-open tab (no flash of its own), so we flash explicitly here.
      if (focusOrAddAgentTab(workspace.id, agentId, agentName)) {
        flashAgentTab(workspace.id, agentId)
        return true
      }
      try {
        // Workspace was cold: seed the tab into the persisted layout, then latch
        // a flash that fires once its Model mounts (see consumePendingAgentFlash).
        store.updateLayout(workspace.id, ensureAgentTabInLayoutModel(workspace.layoutModel, agentId, agentName))
        flashAgentTab(workspace.id, agentId)
        return true
      } catch {
        return false
      }
    },
    publishDiagnostic,
  }
}

// Agent runtime — the irreducible core (terminals, the BYO-CLI launch path, the
// agent session runtime). It is `core: true`, so the resolver always keeps it
// enabled and Settings → Modules renders it as a locked-on toggle the user can't
// turn off. Its renderer surfaces (AgentPanel, TerminalView, PlainTerminalPanel,
// the agents/runState store slices) are always present, so it registers no
// gated panels with the host; it does contribute the always-reachable
// Extensions door surface (MC-1847), and its manifest anchors the dependency
// graph and presents the core in the chooser.
//
// It does own the `agent.terminal` Backlog link kind: when a Backlog item is
// handed to an agent terminal, the item records which agent is working it and
// the agent records the item (AgentState.backlogItemRef). Both directions
// navigate through the always-on core so the link never goes dark on a module
// toggle.
export const agentRuntimeRendererModule: RendererModule = {
  manifest: {
    id: 'agent-runtime',
    displayName: 'Agent Runtime',
    version: 1,
    publisher: 'multicode',
    category: 'core',
    summary:
      'Terminals, agent launch, and the session runtime that every other capability builds on. Always on.',
    defaultEnabled: true,
    core: true,
  },
  registerRenderer(host) {
    // The Plugins modal (doors→modals, 2026-09-01; the Extensions door,
    // MC-1847, before that): registered through the always-on core so the
    // marketplace surface is always reachable. The trigger glyph leads the
    // settings cluster; the id stays `extensions` — it is a persisted-ish
    // surface id and a deep-link target — while every user-facing string says
    // Plugins. A plain open from the glyph discards any stale deep-link latch
    // a dispatch that never mounted left behind (the surface drains the latch
    // on mount, so a stale one would reroute the open).
    host.registerModalSurface({
      id: 'extensions',
      order: 10,
      label: 'Plugins',
      Icon: PluginsGlyph,
      onOpen: () => {
        consumePendingExtensionsSurfaceTarget()
      },
      Component: ExtensionsGlobalSurface,
    })

    host.registerBacklogLinkProvider({
      moduleId: AGENT_RUNTIME_MODULE_ID,
      targetKinds: [AGENT_TERMINAL_TARGET_KIND],
      resolveLinkStatus: async (input) => {
        const { useWorkspaceStore } = await import('../store/workspaceStore')
        return resolveAgentBacklogLink({
          ...input,
          workspaces: useWorkspaceStore.getState().workspaces,
        })
      },
      openLink: async (input) => openAgentBacklogLink({
        ...input,
        ports: await agentBacklogOpenPorts(),
      }),
    })
    // The discoverable click path to the working agent; the links-list row in
    // the detail pane is the secondary control. Ordered after Sprint Engine's
    // actions (order 10) so a run-linked item keeps "Open Sprint Engine"
    // primary.
    host.registerBacklogItemAction({
      id: 'agent-runtime.open-agent',
      label: 'Open agent',
      category: 'execute',
      order: 20,
      isVisible: ({ item }) => item.status !== 'archived' && hasAgentLink(item),
      async run(context) {
        const link = agentLinkForItem(context.item)
        if (!link) return
        await openAgentBacklogLink({
          ...context,
          link,
          ports: await agentBacklogOpenPorts(),
        })
      },
    })
  },
}
