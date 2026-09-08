import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { browserTabLabel } from '../../../../../shared/browser'
import { selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type {
  FuturePlanWorkspaceSource,
  WorkspacePaneTab,
  WorkspacePaneTabKind,
} from '../../../types/workspace'
import { ContextMenu, IconButton, MenuItem, Tabs, TabsScroller, Tooltip, type TabItem } from '../../ui'
import { PANE_KINDS, paneKindDefinition, type PaneLaunchKind } from './paneKinds'
import { dispatchDiffPopoutTarget, type DiffPopoutTarget } from './diffPopoutTarget'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { WORKSPACE_PANE_DATA_ATTRIBUTE } from './paneFocus'
import { closePaneTabAndItsTerminal } from './paneTerminals'
import { WorkspacePaneAddMenu } from './WorkspacePaneAddMenu'
import { WorkspacePaneBody } from './WorkspacePaneBody'
import { WorkspacePaneLauncher } from './WorkspacePaneLauncher'
import { WindowCaptionReserve, windowCaptionReserve } from '../WindowControls'

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

// A window lifting off the strip: the popup the active tab opens into. Distinct
// from the maximise arrows (which grow the pane in place) and from the viewer's
// own "separate window" glyph (which leaves the window entirely).
function PopoutGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 5.5V12a1 1 0 0 0 1 1h6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="5.5" y="3" width="7.5" height="7.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
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

function paneTabLabel(tab: WorkspacePaneTab): string {
  if (tab.kind === 'browser') return browserTabLabel(tab.url, tab.title)
  return tab.title?.trim() || paneKindDefinition(tab.kind).label
}

export default function WorkspacePane({ workspaceId, active, onStartFuturePlan }: WorkspacePaneProps) {
  const paneState = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const openModalSurface = useWorkspaceStore((s) => s.openModalSurface)
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

  // A kind that names a modal surface floats it over the page instead of
  // opening a tab (Reviews). Everything else is a tab of this pane.
  const openKind = useCallback(
    (kind: PaneLaunchKind) => {
      const definition = paneKindDefinition(kind)
      if (definition.modalSurfaceId) {
        openModalSurface(definition.modalSurfaceId)
        return
      }
      openPaneTab(workspaceId, { kind: kind as WorkspacePaneTabKind })
    },
    [openModalSurface, openPaneTab, workspaceId],
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

  // The active tab's popout target, when the tab has one. A Diff tab pops out
  // as the same viewer on the same repository, opened on the same file — the
  // worktree the workspace is mounted on, never the parent checkout a run
  // workspace's folderPath names (the WorkspaceIdentity rule, as the pane body
  // applies it).
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const diffRepoRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return resolveWorkspaceWorktree(ws)?.gitRoot ?? ws.folderPath ?? null
  })
  const popoutTarget: DiffPopoutTarget | null =
    activeTab?.kind === 'diff' && diffRepoRoot
      ? { repoRoot: diffRepoRoot, focusPath: activeTab.diff?.focusPath ?? null, focusKind: activeTab.diff?.focusKind ?? null }
      : null
  const openPopout = useCallback(() => {
    if (!popoutTarget) return
    // Latch first, then open: the modal may mount a tick later and drains the
    // latch then; an already-open popout takes the live event instead.
    dispatchDiffPopoutTarget(popoutTarget)
    openModalSurface('diff')
  }, [openModalSurface, popoutTarget])

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
        {/* Scrolls sideways with no scrollbar and a fade at each overflowing
            edge (TabsScroller): a 10px bar under a 36px strip is a second line
            in a band that already has one, and a plain vertical wheel is the
            gesture people make over a row of tabs. */}
        <TabsScroller className="flex min-w-0 flex-1 items-end self-stretch">
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
        </TabsScroller>
        <div className="app-no-drag flex h-full shrink-0 items-center gap-0.5">
          <WorkspacePaneAddMenu kinds={kinds} onPick={openKind} />
          {/* The pane-to-popup mechanism (2026-09-05): the active tab, floated
              at workbench width over the page. Offered only for the kinds
              that read badly in a column — Diff today — so the strip does not
              grow a control every tab ignores. */}
          {popoutTarget ? (
            <Tooltip content="Open in a popup" placement="bottom">
              <IconButton onClick={openPopout} aria-label="Open in a popup">
                <PopoutGlyph className="icon-sm" />
              </IconButton>
            </Tooltip>
          ) : null}
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
        {/* The pane is the window's rightmost column whenever it is open (and
            the whole row when maximised), so on win/linux the floating caption
            buttons sit over THIS strip's corner: leave them their width, or
            Close-pane hides under Close-window. */}
        <WindowCaptionReserve width={windowCaptionReserve(window.api.platform === 'darwin')} />
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
