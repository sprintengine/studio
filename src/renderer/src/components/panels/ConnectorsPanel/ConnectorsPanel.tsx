// Connectors surface — the browse / install / launch page for connectors, opened
// from the sidebar (T5) via the store `connectorsSurface` overlay. It is NOT a
// Settings tab: it is a WorkspaceManager-rendered overlay so it can receive the
// host's connector "New chat" route as a prop.
//
// The two catalog reads live in the shared `useConnectorSources` hook and the
// Browse body in `ConnectorsBrowseCanvas` (MC-1847): the Extensions door renders
// the same canvas, so this file is only the modal chrome (backdrop, Escape,
// focus capture + restore, scroll-lock) plus the Browse/Installed view switch.

import React, { useEffect, useRef, useState } from 'react'

import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { AgentComposerConnector } from '../../workspace/agentComposer/AgentComposer'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { CloseIconButton, Tabs, TabPanel, type TabItem } from '../../ui'
import { ConnectorsManage } from './ConnectorsManage'
import { ConnectorsBrowseCanvas, useConnectorsBrowseState } from './ConnectorsBrowseCanvas'
import { useConnectorSources } from './useConnectorSources'

// Re-exports for the render guard and any host that composes the browse pieces
// directly (the door surface imports from ConnectorsBrowseCanvas itself).
export { ConnectorsBody, FacetTabs, ReadyConnectorsRail } from './ConnectorsBrowseCanvas'

// Top-level view switch: Browse (the Get grid) vs Installed (the manage view
// folded in from the old MCPs / Skill packs / Extensions settings tabs).
type SurfaceView = 'browse' | 'installed'
const SURFACE_VIEW_PREFIX = 'connectors-view'
const SURFACE_VIEW_ITEMS: TabItem<SurfaceView>[] = [
  { id: 'browse', label: 'Browse' },
  { id: 'installed', label: 'Installed' },
]

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ConnectorsSurfaceProps = {
  // "New chat" on a launchable connector: hands the host the connector so it can
  // open the new-chat composer with it attached. The host — not this surface —
  // decides what that opens; nothing is spawned until the user confirms there.
  onLaunchConnector: (connector: AgentComposerConnector) => void
  // Opens the automation-authoring flow seeded with this connector. The run
  // wiring lands in T8; this presents the route today.
  onUseInAutomation: (serverId: string) => void
  // Active workspace root for workspace-scoped installs / MCP sync; null with no
  // project open (install of workspace-scoped components is then blocked with an
  // honest hint by the reused storefront flow).
  activeWorkspaceRoot: string | null
  // "Use in agent → New agent…" on an installed skill row: spawn a fresh agent
  // with the skill attached (the host closes this surface and spawns).
  onUseSkillInNewAgent?: (skill: WorkspaceSkill) => void
}

// The overlay shell: reads open-state from the store so any surface (sidebar
// entry, command palette) opens it with one action, and owns the modal chrome
// (backdrop, Escape, focus capture + restore, scroll-lock). Renders nothing when
// closed, and only mounts the (catalog-fetching) body while open.
export default function ConnectorsSurface(props: ConnectorsSurfaceProps): JSX.Element | null {
  const open = useWorkspaceStore((s) => s.connectorsSurface.open)
  const closeConnectorsSurface = useWorkspaceStore((s) => s.closeConnectorsSurface)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => {
      const node = surfaceRef.current
      if (node && !node.contains(document.activeElement)) node.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeConnectorsSurface()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (target && document.contains(target)) target.focus()
    }
  }, [open, closeConnectorsSurface])

  if (!open) return null

  const trapFocus = (position: 'start' | 'end') => () => {
    const root = surfaceRef.current
    if (!root) return
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute('data-focus-sentinel'),
    )
    if (focusables.length === 0) {
      root.focus()
      return
    }
    if (position === 'start') focusables[focusables.length - 1].focus()
    else focusables[0].focus()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connectors"
      className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center p-4 outline-none sm:p-8 lg:p-12"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeConnectorsSurface()
      }}
    >
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('start')} className="sr-only" />
      <div
        ref={surfaceRef}
        tabIndex={-1}
        className="flex h-full max-h-[min(760px,calc(100vh-2rem))] w-full max-w-[1080px] flex-col overflow-hidden rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)] outline-none"
      >
        <ConnectorsBrowser {...props} onClose={closeConnectorsSurface} />
      </div>
      <div data-focus-sentinel="true" tabIndex={0} onFocus={trapFocus('end')} className="sr-only" />
    </div>
  )
}

// The surface body: the shared sources + the Browse/Installed view switch. The
// Browse grid itself is the shared ConnectorsBrowseCanvas.
function ConnectorsBrowser({
  onLaunchConnector,
  onUseInAutomation,
  activeWorkspaceRoot,
  onUseSkillInNewAgent,
  onClose,
}: ConnectorsSurfaceProps & { onClose: () => void }) {
  const sources = useConnectorSources(activeWorkspaceRoot)
  // Browsing state lives here, above the TabPanels (which unmount their inactive
  // child), so switching to Installed and back keeps the search/facet/detail.
  const browseState = useConnectorsBrowseState()

  // Top-level surface view: Browse is the catalog/marketplace Get grid; Installed
  // is the manage-what-you-have half folded in from the old MCPs / Skill packs /
  // Extensions settings tabs (T3). Browse leads because getting a connector is the
  // surface's primary job; deep-links (the skill picker's "Manage skills" footer)
  // can land on Installed via the store's initialView.
  const initialView = useWorkspaceStore((s) => s.connectorsSurface.initialView)
  const [view, setView] = useState<SurfaceView>(initialView ?? 'browse')
  // Re-opening with a deep-link while already mounted still lands on it.
  useEffect(() => {
    if (initialView) setView(initialView)
  }, [initialView])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-[color:var(--border-subtle)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-5 text-[color:var(--text-strong)]">Connectors</h2>
          <p className="mt-0.5 text-[12px] leading-4 text-[color:var(--text-subtle)]">
            Browse, install, and launch connectors — an isolated chat or an automation, scoped to its own worktree.
          </p>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close connectors" />
      </header>

      <div className="border-b border-[color:var(--border-subtle)] px-5 pt-2.5">
        <Tabs
          ariaLabel="Connectors view"
          idPrefix={SURFACE_VIEW_PREFIX}
          items={SURFACE_VIEW_ITEMS}
          value={view}
          onChange={setView}
          borderless
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <TabPanel idPrefix={SURFACE_VIEW_PREFIX} tabId="browse" active={view === 'browse'}>
          <ConnectorsBrowseCanvas
            sources={sources}
            state={browseState}
            workspaceRoot={activeWorkspaceRoot}
            onLaunchConnector={onLaunchConnector}
            onUseInAutomation={onUseInAutomation}
          />
        </TabPanel>

        <TabPanel idPrefix={SURFACE_VIEW_PREFIX} tabId="installed" active={view === 'installed'}>
          <ConnectorsManage
            activeWorkspaceRoot={activeWorkspaceRoot}
            catalogServers={sources.catalogLoad.status === 'ready' ? sources.catalogLoad.data : []}
            onLaunchConnector={onLaunchConnector}
            onUseInAutomation={onUseInAutomation}
            onUseSkillInNewAgent={onUseSkillInNewAgent}
          />
        </TabPanel>
      </div>
    </div>
  )
}
