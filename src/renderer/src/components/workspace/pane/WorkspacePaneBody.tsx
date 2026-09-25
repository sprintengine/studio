import React from 'react'

import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../types/workspace'
import { SuspenseFallback } from '../../ui/SuspenseFallback'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import { useChangelists } from '../../../hooks/useChangelists'
import { defaultDiffChangelistId } from '../../../utils/diffChangelistDefault'
import { paneKindRetainsPanel } from './paneKinds'
import { FLOATING_PAGE_INSET, FloatingPlayerChrome, useFloatRect } from './FloatingPlayer'

// The pane's content region: one layer per tab that needs to stay mounted
// (terminal, browser, canvas) plus the active tab. Inactive retained layers are
// `invisible` rather than `hidden` so xterm keeps its measured size and a tab
// switch never refits the buffer; everything else mounts only while showing.
// A canvas layer hides the same way, and for the same reason: the editor
// measures its container, and a layer with no box would be re-laid-out on
// every tab switch. The offscreen park below is the browser's alone — it exists
// because a <webview> guest cannot survive `visibility: hidden`.

const FileExplorer = React.lazy(() => import('../../panels/FileExplorer'))
const PlainTerminalPanel = React.lazy(() => import('../../panels/PlainTerminalPanel'))
// Monaco rides with the diff viewer; lazy so a pane without a Diff tab never
// pays for it.
const DiffViewer = React.lazy(() =>
  import('../../auxWindows/DiffViewer').then((module) => ({ default: module.DiffViewer })),
)
const BrowserTab = React.lazy(() => import('./browser/BrowserTab').then((module) => ({ default: module.BrowserTab })))
// The canvas editor is the heaviest dependency in the tree, and this is the
// boundary that keeps it out of the boot chunk (scripts/check-bundle-budget.mjs
// fails the build if its signature reaches there). A local lazy const rather
// than a host-registered panel because the tab needs the tab RECORD — which
// board it is on — and whether it is the one on screen, and a host panel is
// handed neither; the same split dev-tools makes for its explorer.
const CanvasTab = React.lazy(() => import('./canvas/CanvasTab').then((module) => ({ default: module.CanvasTab })))

// An inactive layer is normally `invisible`; a browser layer is parked
// offscreen instead. Electron blanks a `visibility:hidden` guest for good on
// macOS, and a guest fully outside the window stops compositing without
// losing its page. Parking is the only hiding a browser layer survives.
export const OFFSCREEN_LAYER_STYLE: React.CSSProperties = {
  visibility: 'visible',
  transform: 'translateX(-100000px)',
  pointerEvents: 'none',
}

// The explicit, labelled unavailable state (never a silently blank surface) —
// the same copy WorkspaceLayout shows for a disabled or stale FlexLayout tab.
function PaneUnavailable() {
  return (
    <div
      role="note"
      aria-label="Panel unavailable"
      className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
    >
      <p className="text-meta font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
      <p className="max-w-xs text-micro leading-5 text-[color:var(--text-muted)]">
        This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
      </p>
    </div>
  )
}

/**
 * The pane's Diff tab, and the one place the DEFAULT changelist filter is
 * chosen (agent changelists, Wave 4).
 *
 * It lives here rather than in the pane's "+" menu because every way of opening
 * an unaddressed Diff tab ends here: the "+ Diff" item, the letter accelerator,
 * a Diff tab restored from disk with nothing in it. A filter picked at the menu
 * would be picked once and then be wrong for the other two.
 *
 * The rule is narrow on purpose. A tab that names a changelist keeps it; a tab
 * that names a FILE keeps all changes, because a person who asked for a file's
 * diff has not asked to be shown one agent's slice of the repository — and a
 * default filter that hid the file they asked for would be the worst failure
 * this feature can have. Only the empty request consults the workspace.
 *
 * Its own component so the changelist read is mounted with the Diff tab and
 * nowhere else: a hook in `PaneTabPanel` would run for every tab kind.
 */
function PaneDiffTab({
  workspaceId,
  repoRoot,
  tab,
  onDiffCountChange,
}: {
  workspaceId: string
  repoRoot: string
  tab: WorkspacePaneTab
  onDiffCountChange?: (count: number | null) => void
}) {
  const lastActiveAgentId = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.lastActiveAgentId ?? null,
  )
  const asked = tab.diff?.changelistId ?? null
  const wantsDefault = !asked && !tab.diff?.focusPath && Boolean(lastActiveAgentId)
  // Read only when a default is actually in question. An addressed Diff tab
  // makes no changelist call at all, which is what keeps every diff opened from
  // a Git row exactly the diff it was before.
  const { changelists } = useChangelists(wantsDefault ? repoRoot : null)
  const changelistId = asked ?? (wantsDefault ? defaultDiffChangelistId({ lastActiveAgentId }, changelists) : null)

  return (
    <DiffViewer
      // Keyed on the repo only: a Git row click retargets the mounted
      // viewer through its focus props. Remounting per target (the aux
      // window's rule) disposes Monaco's models under the diff widget.
      // The changelist is deliberately NOT in the key: the default settles a
      // tick after mount, and remounting on it would flash Monaco on the way
      // into every unaddressed Diff tab.
      key={repoRoot}
      repoRoot={repoRoot}
      focusPath={tab.diff?.focusPath ?? null}
      focusKind={tab.diff?.focusKind ?? null}
      changelistId={changelistId}
      // Carried into the window when the band's "Open in separate
      // window" is used, so that window's "Show in the app" knows the
      // pane it came from and can hand the diff back.
      workspaceId={workspaceId}
      variant="pane"
      onItemCountChange={onDiffCountChange}
      // The pane is the only host with a branch to step through; the aux
      // window opens on one file of the working tree.
      branchSteps
      // An agent's editor.open_diff: its narrowing, the step it named, and the
      // lines to land on. Absent for every diff a person opens.
      pathsFilter={tab.diff?.reveal?.paths ?? null}
      focusStep={tab.diff?.reveal?.step ?? null}
      focusRange={tab.diff?.reveal?.range ?? null}
      focusSide={tab.diff?.reveal?.side ?? 'modified'}
      revealKey={tab.diff?.reveal?.key ?? null}
    />
  )
}

type PaneTabPanelProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
  onDiffCountChange?: (count: number | null) => void
}

function PaneTabPanel({ workspaceId, tab, active, onDiffCountChange }: PaneTabPanelProps) {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // The diff reads the worktree the workspace is mounted on, not the parent
  // checkout a run workspace's folderPath names (the WorkspaceIdentity rule).
  const diffRepoRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return null
    return resolveWorkspaceWorktree(ws)?.gitRoot ?? ws.folderPath ?? null
  })
  switch (tab.kind) {
    case 'files':
      return selectModuleEnabled(moduleOverrides, 'dev-tools') ? (
        <FileExplorer workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    case 'git': {
      // Git is a host-registered panel (git-module.ts); the pane renders the
      // registered component so a disabled module answers with absence.
      const GitPanel = getRendererHost().getPanel('git')
      return GitPanel && selectModuleEnabled(moduleOverrides, 'git') ? (
        <GitPanel workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    }
    case 'backlog': {
      // The workspace's Backlog panel, registered by backlog-module.ts. It
      // takes the same props the FlexLayout rail handed it, future plans
      // included.
      const BacklogPanel = getRendererHost().getPanel('backlog')
      return BacklogPanel && selectModuleEnabled(moduleOverrides, 'backlog') ? (
        <BacklogPanel workspaceId={workspaceId} />
      ) : (
        <PaneUnavailable />
      )
    }
    case 'terminal':
      return tab.terminalId ? (
        <PlainTerminalPanel workspaceId={workspaceId} terminalId={tab.terminalId} />
      ) : (
        <PaneUnavailable />
      )
    case 'browser':
      return <BrowserTab workspaceId={workspaceId} tab={tab} active={active} />
    case 'canvas':
      return selectModuleEnabled(moduleOverrides, 'canvas') ? (
        <CanvasTab workspaceId={workspaceId} tab={tab} active={active} />
      ) : (
        <PaneUnavailable />
      )
    case 'diff': {
      // The opener's repository wins: the Git panel can be showing a worktree
      // scope that is not the workspace's own checkout, and re-deriving one
      // here opened the tab on a different repository than the row came from.
      // The derived root is the fallback for a Diff tab opened from the pane's
      // own + menu, which names no repository at all.
      const repoRoot = tab.diff?.repoRoot ?? diffRepoRoot
      return repoRoot && selectModuleEnabled(moduleOverrides, 'git') ? (
        <PaneDiffTab workspaceId={workspaceId} repoRoot={repoRoot} tab={tab} onDiffCountChange={onDiffCountChange} />
      ) : (
        <PaneUnavailable />
      )
    }
    default:
      return <PaneUnavailable />
  }
}

type WorkspacePaneBodyProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  /** The tab whose panel is on screen: null when the pane is collapsed or the workspace is not the visible one. */
  activeTabId: string | null
  /** The tab the strip has selected, visible or not; decides which panel is the front one. */
  selectedTabId: string | null
  onDiffCountChange?: (count: number | null) => void
}

export function WorkspacePaneBody({
  workspaceId,
  tabs,
  activeTabId,
  selectedTabId,
  onDiffCountChange,
}: WorkspacePaneBodyProps) {
  const floatingTab = tabs.find((tab) => tab.floating && tab.kind === 'browser') ?? null
  const floatRect = useFloatRect(workspaceId, floatingTab)
  return (
    <>
      {tabs.map((tab) => {
        const floating = tab.id === floatingTab?.id && floatRect !== null
        const selected = tab.id === selectedTabId || floating
        const active = floating || (selected && tab.id === activeTabId)
        if (!selected && !paneKindRetainsPanel(tab.kind)) return null
        const offscreen = !selected && tab.kind === 'browser'
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`pane-${workspaceId}-panel-${tab.id}`}
            aria-labelledby={`pane-${workspaceId}-tab-${tab.id}`}
            aria-hidden={!selected}
            // No stacking tier: an unselected panel is offscreen (browser) or
            // invisible (terminal), so the selected one is the only paint.
            // `aria-hidden` below is load-bearing as well as correct: a canvas
            // layer needs its subtree hidden a second time, because the editor's
            // own stylesheet takes `visibility` back on a few of its nodes, and
            // `canvasTheme.css` matches those layers through this attribute.
            //
            // FLOATING is the one case that leaves the pane's box: the SAME
            // element is restyled to `position: fixed`, never moved in the
            // tree. Re-parenting a <webview> unmounts and remounts it, and the
            // page reloads — losing exactly the state the float exists to keep
            // in view. No ancestor between here and the viewport carries a
            // transform, so `fixed` resolves against the viewport.
            //
            // Floating, it is an overlay and takes the overlay pair: the modal
            // shadow and `--radius-lg`, the shell step. Docked it wears the
            // pane's own card radius, which is a step above what the shape ramp
            // allows anything casting an overlay shadow.
            className={
              floating
                ? 'fixed z-[var(--z-pane)] overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)]'
                : `absolute inset-0 ${selected ? 'visible' : offscreen ? '' : 'invisible'}`
            }
            style={
              floating
                ? {
                    ...floatRect,
                    // The page starts below the drag bar. `height: 100%` on the
                    // child resolves against this content box, so the guest is
                    // sized correctly without knowing the bar exists.
                    paddingTop: FLOATING_PAGE_INSET,
                    pointerEvents: 'auto',
                  }
                : offscreen
                  ? OFFSCREEN_LAYER_STYLE
                  : { pointerEvents: selected ? 'auto' : 'none' }
            }
            // An offscreen layer is still in the DOM: `inert` keeps its address
            // field and buttons out of the tab order (the invisible ones are
            // unfocusable already).
            {...(offscreen ? ({ inert: '' } as Record<string, string>) : {})}
          >
            {floating ? <FloatingPlayerChrome workspaceId={workspaceId} tab={tab} rect={floatRect} /> : null}
            <React.Suspense fallback={<SuspenseFallback label="Loading pane" />}>
              <PaneTabPanel workspaceId={workspaceId} tab={tab} active={active} onDiffCountChange={onDiffCountChange} />
            </React.Suspense>
          </div>
        )
      })}
    </>
  )
}
