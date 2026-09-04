import React, { useCallback, useMemo, useState } from 'react'

import { selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type {
  FuturePlanWorkspaceSource,
  WorkspacePaneTab,
  WorkspacePaneTabKind,
} from '../../../types/workspace'
import { ContextMenu, IconButton, MenuItem, Tabs, Tooltip, type TabItem } from '../../ui'
import { PANE_KINDS, paneKindDefinition } from './paneKinds'
import { WORKSPACE_PANE_DATA_ATTRIBUTE } from './paneFocus'
import { WorkspacePaneAddMenu } from './WorkspacePaneAddMenu'
import { WorkspacePaneBody } from './WorkspacePaneBody'
import { WorkspacePaneLauncher } from './WorkspacePaneLauncher'

// One workspace's pane: the 36px strip (tabs · + · maximise · close) over the
// tab bodies. Mounted once per retained workspace by WorkspacePaneColumn so a
// terminal (later a browser) survives a workspace switch; `active` says
// whether this is the one on screen.

function MaximiseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M9.5 3H13v3.5M6.5 13H3V9.5M13 3 9.2 6.8M3 13l3.8-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RestoreGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M13 3 9.5 6.5M9.5 3v3.5H13M3 13l3.5-3.5M6.5 13V9.5H3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The same panel-right rect the header's pane switch draws: one glyph for the
// column on both ends of the gesture.
function ClosePaneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type TabMenuState = { x: number; y: number; tabId: string }

type WorkspacePaneProps = {
  workspaceId: string
  active: boolean
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

export function paneTabLabel(tab: WorkspacePaneTab): string {
  return tab.title?.trim() || paneKindDefinition(tab.kind).label
}

export default function WorkspacePane({ workspaceId, active, onStartFuturePlan }: WorkspacePaneProps) {
  const paneState = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const closePaneTab = useWorkspaceStore((s) => s.closePaneTab)
  const setActivePaneTab = useWorkspaceStore((s) => s.setActivePaneTab)
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen)
  const setMaximised = useWorkspaceStore((s) => s.setWorkspacePaneMaximised)

  const tabs = paneState?.tabs ?? []
  const activeTabId = paneState?.activeTabId ?? null
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  // The Diff tab's canonical count — the files its viewer lists — reported by
  // the viewer while it is mounted; null until it has answered.
  const [diffCount, setDiffCount] = useState<number | null>(null)

  // Kinds whose module is on. A disabled module's kind is absent, not greyed.
  const kinds = useMemo(
    () => PANE_KINDS.filter((definition) => !definition.moduleId || selectModuleEnabled(moduleOverrides, definition.moduleId)),
    [moduleOverrides],
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return
      // A pane terminal's pty dies with its tab, exactly as a FlexLayout
      // terminal tab's does (WorkspaceLayout.cleanupNode).
      if (tab.kind === 'terminal' && tab.terminalId) {
        void window.api.terminalKill(`terminal-${tab.terminalId}`).catch(() => {})
      }
      closePaneTab(workspaceId, tabId)
    },
    [closePaneTab, tabs, workspaceId],
  )

  const closeTabsWhere = useCallback(
    (predicate: (tab: WorkspacePaneTab, index: number) => boolean) => {
      tabs.forEach((tab, index) => {
        if (predicate(tab, index)) closeTab(tab.id)
      })
    },
    [closeTab, tabs],
  )

  const openKind = useCallback(
    (kind: WorkspacePaneTabKind) => {
      openPaneTab(workspaceId, { kind })
    },
    [openPaneTab, workspaceId],
  )

  const items: TabItem[] = tabs.map((tab) => {
    const label = paneTabLabel(tab)
    const { Glyph } = paneKindDefinition(tab.kind)
    return {
      id: tab.id,
      label,
      closeLabel: `Close ${label}`,
      ...(tab.kind === 'diff' && diffCount !== null ? { count: diffCount } : {}),
      icon: tab.faviconUrl
        ? <img src={tab.faviconUrl} alt="" className="size-icon-xs shrink-0 rounded-[3px]" />
        : <Glyph className="size-icon-xs shrink-0" />,
    }
  })

  const menuTabIndex = tabMenu ? tabs.findIndex((tab) => tab.id === tabMenu.tabId) : -1

  return (
    <section
      aria-label="Workspace pane"
      {...{ [WORKSPACE_PANE_DATA_ATTRIBUTE]: workspaceId }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* The strip: the pane's one band of chrome, on the header's 36px
          baseline. Its empty run drags the window; the controls opt out. */}
      <div className="app-drag flex h-[36px] shrink-0 items-center border-b border-[color:var(--border-default)] pl-1.5 pr-1">
        <div className="app-no-drag flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.length > 0 && activeTabId ? (
            <Tabs
              ariaLabel="Pane tabs"
              idPrefix={`pane-${workspaceId}`}
              items={items}
              value={activeTabId}
              onChange={(tabId) => setActivePaneTab(workspaceId, tabId)}
              onCloseItem={closeTab}
              onItemAuxClick={(tabId, event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(tabId)
                }
              }}
              onItemContextMenu={(tabId, event) => {
                event.preventDefault()
                setTabMenu({ x: event.clientX, y: event.clientY, tabId })
              }}
              borderless
            />
          ) : null}
        </div>
        <div role="toolbar" aria-label="Pane controls" className="app-no-drag flex shrink-0 items-center gap-0.5">
          <WorkspacePaneAddMenu kinds={kinds} onPick={openKind} />
          <Tooltip content={maximised ? 'Restore pane' : 'Maximise pane'} placement="bottom">
            <IconButton
              onClick={() => setMaximised(!maximised)}
              aria-label={maximised ? 'Restore pane' : 'Maximise pane'}
              pressed={maximised}
            >
              {maximised ? <RestoreGlyph className="icon-sm" /> : <MaximiseGlyph className="icon-sm" />}
            </IconButton>
          </Tooltip>
          <Tooltip content="Close pane" placement="bottom">
            <IconButton onClick={() => setPaneOpen(workspaceId, false)} aria-label="Close pane">
              <ClosePaneGlyph className="icon-sm" />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <WorkspacePaneLauncher kinds={kinds} onPick={openKind} />
        ) : (
          <WorkspacePaneBody
            workspaceId={workspaceId}
            tabs={tabs}
            activeTabId={activeTabId}
            onStartFuturePlan={onStartFuturePlan}
            onDiffCountChange={setDiffCount}
          />
        )}
      </div>
      {tabMenu && active ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel="Pane tab actions"
          onClose={() => setTabMenu(null)}
          surfaceClassName="min-w-[180px]"
        >
          <MenuItem onClick={() => closeTab(tabMenu.tabId)}>Close</MenuItem>
          <MenuItem
            disabled={tabs.length <= 1}
            onClick={() => closeTabsWhere((tab) => tab.id !== tabMenu.tabId)}
          >
            Close others
          </MenuItem>
          <MenuItem
            disabled={menuTabIndex === -1 || menuTabIndex >= tabs.length - 1}
            onClick={() => closeTabsWhere((_tab, index) => index > menuTabIndex)}
          >
            Close to the right
          </MenuItem>
        </ContextMenu>
      ) : null}
    </section>
  )
}
