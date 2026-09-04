import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { browserTabLabel } from '../../../../../shared/browser'
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
import { closePaneTabAndItsTerminal } from './paneTerminals'
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
  if (tab.kind === 'browser') return browserTabLabel(tab.url, tab.title)
  return tab.title?.trim() || paneKindDefinition(tab.kind).label
}

export default function WorkspacePane({ workspaceId, active, onStartFuturePlan }: WorkspacePaneProps) {
  const paneState = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const setActivePaneTab = useWorkspaceStore((s) => s.setActivePaneTab)
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen)
  const setMaximised = useWorkspaceStore((s) => s.setWorkspacePaneMaximised)

  const tabs = paneState?.tabs ?? []
  const activeTabId = paneState?.activeTabId ?? null
  // What the agent tools act on when they name no tab: the browser tab the
  // person is looking at, or none when the active tab is not a browser.
  const activeBrowserTabId = tabs.find((tab) => tab.id === activeTabId && tab.kind === 'browser')?.id ?? null
  useEffect(() => {
    void window.api.browserNoteActive(workspaceId, activeBrowserTabId)
  }, [activeBrowserTabId, workspaceId])
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
      if (tab) closePaneTabAndItsTerminal(workspaceId, tab)
    },
    [tabs, workspaceId],
  )

  // Closing the column with focus inside it would strand the keyboard in
  // hidden chrome; the header's pane switch is where the gesture came from.
  const closePane = useCallback(() => {
    setPaneOpen(workspaceId, false)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-pane-switch]')?.focus()
    })
  }, [setPaneOpen, workspaceId])

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
      aria-label={workspaceName ? `${workspaceName} pane` : 'Workspace pane'}
      {...{ [WORKSPACE_PANE_DATA_ATTRIBUTE]: workspaceId }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* The strip: the pane's one band of chrome, on the header's 36px
          baseline. Its empty run drags the window; the tabs and the controls
          opt out. Tabs sit on the strip's bottom edge so the active underline
          draws ON the hairline, as the tabs component specifies. */}
      <div className="app-drag flex h-[36px] shrink-0 items-end border-b border-[color:var(--border-default)] pl-1.5 pr-1">
        <div className="flex min-w-0 flex-1 items-end self-stretch overflow-x-auto overflow-y-hidden">
          {tabs.length > 0 && activeTabId ? (
            <Tabs
              ariaLabel="Pane tabs"
              className="app-no-drag"
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
        <div className="app-no-drag flex h-full shrink-0 items-center gap-0.5">
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
            <IconButton onClick={closePane} aria-label="Close pane">
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
            // A tab is "active" for its panel only while someone can see it:
            // this workspace on screen and the pane open. A collapsed pane's
            // browser tab must not keep polling for dev servers.
            activeTabId={active && (paneState?.open ?? false) ? activeTabId : null}
            selectedTabId={activeTabId}
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
