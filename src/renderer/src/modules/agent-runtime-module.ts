import React from 'react'

import type { RendererModule } from './renderer-host'
import {
  agentBacklogOpenPorts,
  openAgentBacklogLink,
  resolveAgentBacklogLink,
  AGENT_RUNTIME_MODULE_ID,
  AGENT_TERMINAL_TARGET_KIND,
} from '../utils/agentBacklogLinks'
import {
  consumePendingExtensionsSurfaceTarget,
  dispatchExtensionsSurfaceTarget,
  EXTENSIONS_DRAWER_VIEWS,
} from '../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { CliGlyph, McpGlyph, SkillsGlyph } from '../components/ui/CapabilityGlyphs'
import { PluginsGlyph } from '../components/workspace/surfaceGlyphs'

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
    // Open on the bell rows the hosted feed writes (new models, a CLI update,
    // an app update ready): each carries `{ kind: 'settings', ref: <tab> }`
    // and lands on that Settings tab. Registered through the always-on core so
    // the rows always have their Open.
    for (const source of ['models', 'cli', 'update'] as const) {
      host.registerNotificationActionProvider({
        source,
        resolveActions: ({ notification }) => {
          const target = notification.navigationTarget
          if (target?.kind !== 'settings') return []
          return [
            {
              id: `${source}.open-settings`,
              label: 'Open',
              run: async () => {
                const { useWorkspaceStore } = await import('../store/workspaceStore')
                useWorkspaceStore.getState().openSettingsOverlay({ initialTab: target.ref || 'agents' })
              },
            },
          ]
        },
      })
    }
    // Open on the source drift notice ("A plugin source has updates … Open
    // Plugins and press Sync"): the bell row lands on the Plugins view, where
    // the source's tab wears its update mark and Sync is — or on Skills when
    // the emitter said so. Until 2026-09-08 this source had no action at all,
    // and a notice that names a place must be able to take you there.
    host.registerNotificationActionProvider({
      source: 'marketplace',
      resolveActions: ({ notification }) => [
        {
          id: 'marketplace.open-catalogue',
          label: 'Open',
          run: async () => {
            const { useWorkspaceStore } = await import('../store/workspaceStore')
            dispatchExtensionsSurfaceTarget({
              view:
                notification.extensionsRow === 'skills'
                  ? EXTENSIONS_DRAWER_VIEWS.skills
                  : EXTENSIONS_DRAWER_VIEWS.plugins,
            })
            useWorkspaceStore.getState().openGlobalSurface('extensions')
          },
        },
      ],
    })
    // The Plugins door (Extensions drawer ruling, 2026-09-05 — "surfaces, not
    // modals"; the Extensions door of MC-1847, then a modal from 2026-09-01).
    // Registered through the always-on core so the catalogue is always
    // reachable. The id stays `extensions` — it is a persisted surface id and a
    // deep-link target — while every user-facing string says Plugins. A plain
    // open discards any stale deep-link latch a dispatch that never mounted
    // left behind (the surface drains the latch on mount, so a stale one would
    // reroute the open).
    //
    // No `railPlacement` any more. It said "this door's rail renders beside its
    // canvas rather than replacing the sidebar column", which mattered while
    // the door carried a nested Sources rail. The source-tabs ruling
    // (2026-09-05) replaced that rail with the tab row, so the door declares no
    // rail at all — and GlobalSurfaceShell's contract for a surface that brings
    // none is exactly what is wanted: the host keeps its own column, which is
    // the Extensions drawer the person arrived by.
    host.registerGlobalSurface({
      id: 'extensions',
      label: 'Plugins',
      Icon: PluginsGlyph,
      onOpen: () => {
        consumePendingExtensionsSurfaceTarget()
      },
      // Three rows in the Extensions drawer, not one (drawer ruling,
      // 2026-09-05: Sprints · Design · Plugins · Skills · Agent CLIs). Plugins,
      // Skills and Agent CLIs are separate destinations to the operator even
      // though one surface still renders all three, so each contributes its own
      // row here rather than the shell learning this module's sections. Each
      // opens by the deep-link latch the surface already drains, so the row and
      // a notification's Open arrive by exactly one route. The latch names the
      // view itself since the source-tabs ruling: `browse` used to stand in for
      // Plugins and did not reach the Plugins catalogue at all once the surface
      // grew one.
      views: [
        {
          id: EXTENSIONS_DRAWER_VIEWS.plugins,
          label: 'Plugins',
          Icon: McpGlyph,
          open: () => dispatchExtensionsSurfaceTarget({ view: EXTENSIONS_DRAWER_VIEWS.plugins }),
        },
        {
          id: EXTENSIONS_DRAWER_VIEWS.skills,
          label: 'Skills',
          Icon: SkillsGlyph,
          open: () => dispatchExtensionsSurfaceTarget({ view: EXTENSIONS_DRAWER_VIEWS.skills }),
        },
        {
          id: EXTENSIONS_DRAWER_VIEWS.agentClis,
          label: 'Agent CLIs',
          Icon: CliGlyph,
          open: () => dispatchExtensionsSurfaceTarget({ view: EXTENSIONS_DRAWER_VIEWS.agentClis }),
        },
      ],
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
  },
}
