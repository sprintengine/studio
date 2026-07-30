// The active workspace's identity cluster — star toggle, name, project
// (folder-name) chip, and branch chip — hoisted out of the retired 48px WorkspaceTopBar
// row into the merged AppTitleBar title strip (it fills the title bar's centre
// slot). It is a display surface, not a control group, so it sits outside the
// top-bar-group cap (knowledge/brand/panel-design-system.md TopBar inventory).
//
// The star, project, and branch segments are interactive (toggle starred /
// toggle Files / toggle Git) and opt out of the title strip's drag region with
// `app-no-drag`; the name keeps its sidebar-toggle role (or degrades to a
// draggable span) to preserve the window grab area.

import React from 'react'
import { FOCUS_RING_CLASS, OutlineButton, SplitButton, StarGlyph, Tooltip, type SplitButtonItem } from '../ui'
import { CursorErrorPopover, type CursorAnchor } from '../ui/CursorErrorPopover'
import { publishDiagnostic } from '../../utils/diagnostics'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useGitStatus } from '../../hooks/useGitStatus'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { selectModuleEnabled } from '../../modules'
import { getHighlightSwatch, isStarred } from '../../utils/highlight'
import { toggleNavRailComponent } from '../../utils/modelRegistry'
import type {
  FolderOpenTargetAvailability,
  FolderOpenTargetId,
} from '../../../../shared/folder-open-targets'
import {
  availableFolderOpenTargets,
  folderOpenTargetLabel,
  offersFolderOpenMenu,
  resolveFolderOpenPrimary,
} from './openInEditorTargets'
import type { Workspace } from '../../types/workspace'

// Branch-fork glyph for the header identity cluster. Stroke idiom matches the
// Git panel's local icons (1.3px round strokes on a 16px box) so the two Git
// surfaces read as one family.
function GitBranchGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <circle cx="5" cy="3.6" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="12.4" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="4.2" r="1.55" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 5.15v5.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M11 5.75v.7a3.1 3.1 0 0 1-3.1 3.1H6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Folder glyph for the project chip. Same stroke idiom as GitBranchGlyph
// (1.3px round strokes on a 16px box) so the two identity chips read as a set.
function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <path
        d="M2.1 4.4a1.3 1.3 0 0 1 1.3-1.3h2.6l1.4 1.5h5.2a1.3 1.3 0 0 1 1.3 1.3v5.4a1.3 1.3 0 0 1-1.3 1.3H3.4a1.3 1.3 0 0 1-1.3-1.3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The target mark: a two-letter mono mark for the editors, the folder glyph for
// the OS file manager. Boxed at one size so the three read at the same weight
// whichever form they take, and so the primary half says which tool it will
// open without a caption. Keyed by target rather than chained ternaries, so
// adding a target to the shared id list fails to compile here instead of
// silently drawing the wrong mark.
const TARGET_MARK: Record<FolderOpenTargetId, React.ReactNode> = {
  vscode: 'VS',
  intellij: 'IJ',
  finder: <FolderGlyph className="size-icon-xs" />,
}

function TargetGlyph({ target }: { target: FolderOpenTargetId }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-icon-sm shrink-0 place-items-center rounded-[3px] bg-[color:var(--bg-active)] font-mono text-micro font-medium leading-none tracking-tight text-[color:var(--text-muted)]"
    >
      {TARGET_MARK[target]}
    </span>
  )
}

/**
 * Open the workspace's active checkout in an external tool. Primary half runs
 * the last-used target; the chevron half lists every target that actually
 * resolves and re-points the primary (item 1990).
 *
 * Three rules the surface depends on:
 * - **Probe-hide, not probe-disable.** An editor that is not installed is
 *   absent from the menu, the same rule the agent pickers follow for
 *   uninstalled CLIs. A disabled row for a missing editor is a fake affordance.
 * - **The active checkout, not the project root.** A worktree-backed workspace
 *   opens its worktree, resolved through `resolveWorkspaceWorktree` exactly as
 *   the Git view and the branch chip above do — opening the parent checkout
 *   would show the operator a different branch than the one their agents run on.
 * - **A failed launch is visible and stops there.** The typed failure from the
 *   IPC is surfaced on the control; nothing silently retries in another editor.
 */
export function OpenWorkspaceFolderButton({
  workspaceId,
  openPath,
}: {
  workspaceId: string | null
  /** The checkout to open — already worktree-resolved by the caller. */
  openPath: string
}) {
  const isMac = window.api.platform === 'darwin'
  const lastTarget = useWorkspaceStore((state) => state.appSettings.lastFolderOpenTarget)
  const setLastTarget = useWorkspaceStore((state) => state.setLastFolderOpenTarget)
  // null until the first probe answers: the control does not render before it
  // knows which targets exist, rather than guessing a primary and correcting it.
  const [availability, setAvailability] = React.useState<FolderOpenTargetAvailability[] | null>(null)
  const [failure, setFailure] = React.useState<{ message: string; anchor: CursorAnchor } | null>(null)
  const primaryRef = React.useRef<HTMLButtonElement | null>(null)

  const probe = React.useCallback(async () => {
    try {
      return await window.api.listFolderOpenTargets()
    } catch (error) {
      // The probe is the whole basis for what this control offers, so a failed
      // one leaves it unrendered rather than showing a menu we cannot stand
      // behind. Reported through the diagnostics channel, not in the operator's
      // face on a boot they did not ask anything of.
      void publishDiagnostic({
        level: 'error',
        source: 'filesystem',
        title: 'Could not list open-in-editor targets',
        message: 'The workspace bar cannot offer an external editor until the check succeeds.',
        details: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void probe().then((result) => {
      if (!cancelled && result) setAvailability(result)
    })
    return () => {
      cancelled = true
    }
  }, [probe])

  const available = React.useMemo(() => availableFolderOpenTargets(availability), [availability])
  const primaryTarget = resolveFolderOpenPrimary(available, lastTarget)

  const showFailure = React.useCallback(
    (target: FolderOpenTargetId, detail: string) => {
      const rect = primaryRef.current?.getBoundingClientRect()
      setFailure({
        message: `Could not open ${folderOpenTargetLabel(target, isMac)}: ${detail}`,
        anchor: rect
          ? { x: rect.left + rect.width / 2, y: rect.bottom }
          : { x: window.innerWidth / 2, y: 0 },
      })
    },
    [isMac],
  )

  const openTarget = React.useCallback(
    async (target: FolderOpenTargetId, remember: boolean) => {
      let result
      try {
        result = await window.api.openFolderInTarget({ target, path: openPath })
      } catch (error) {
        // The channel itself failed, which is not one of the typed outcomes. It
        // still has to reach the operator: every caller invokes this as
        // fire-and-forget, so without this the click would be a silent no-op
        // (and an unhandled rejection).
        showFailure(target, error instanceof Error ? error.message : String(error))
        return
      }
      if (result.ok) {
        // Remembered only on a launch that happened: repointing the primary at
        // an editor that just failed would repeat the failure on the next click.
        if (remember) setLastTarget(target)
        return
      }
      showFailure(target, result.message)
    },
    [openPath, setLastTarget, showFailure],
  )

  // `Primary+O` (workspace.folder.reveal) reveals the same checkout in the file
  // manager. It routes here rather than calling the IPC itself so the shortcut
  // and the control cannot disagree about which folder the workspace is on. It
  // deliberately does NOT re-point the primary half: a shortcut for one target
  // is not a choice of default.
  React.useEffect(() => {
    if (!workspaceId) return
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id !== 'workspace.folder.reveal') return
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return
      void openTarget('finder', false)
    }
    window.addEventListener('multicode:panel-command', onPanelCommand)
    return () => window.removeEventListener('multicode:panel-command', onPanelCommand)
  }, [openTarget, workspaceId])

  const items = React.useMemo<SplitButtonItem[]>(
    () =>
      available.map((target) => ({
        id: target,
        label: folderOpenTargetLabel(target, isMac),
        icon: <TargetGlyph target={target} />,
        shortcut: target === 'finder' ? (isMac ? '⌘O' : 'Ctrl+O') : undefined,
        checked: target === primaryTarget,
        onSelect: () => void openTarget(target, true),
      })),
    [available, isMac, openTarget, primaryTarget],
  )

  if (!primaryTarget) return null

  // Re-probed whenever the menu opens: an editor installed while the app was
  // running should appear without a restart, and one uninstalled since boot
  // should stop being offered.
  const reprobe = (open: boolean) => {
    if (open) void probe().then((result) => result && setAvailability(result))
  }

  return (
    <>
      {!offersFolderOpenMenu(available) ? (
        // Nothing to choose between — no editor resolved, so the file manager is
        // the only target. A chevron whose menu holds one row, already the
        // primary, is a control that opens to say nothing; this is a plain
        // button until a second target exists.
        <OutlineButton
          ref={primaryRef}
          className="app-no-drag shrink-0 gap-1.5"
          aria-label={`Open workspace folder in ${folderOpenTargetLabel(primaryTarget, isMac)}`}
          onClick={() => void openTarget(primaryTarget, false)}
        >
          <TargetGlyph target={primaryTarget} />
          Open
        </OutlineButton>
      ) : (
        <SplitButton
          className="app-no-drag shrink-0"
          label="Open"
          glyph={<TargetGlyph target={primaryTarget} />}
          primaryAriaLabel={`Open workspace folder in ${folderOpenTargetLabel(primaryTarget, isMac)}`}
          menuAriaLabel="Open workspace folder in…"
          items={items}
          onPrimary={() => void openTarget(primaryTarget, false)}
          onMenuOpenChange={reprobe}
          primaryRef={primaryRef}
        />
      )}
      {failure ? (
        <CursorErrorPopover
          key={`${failure.anchor.x},${failure.anchor.y},${failure.message}`}
          message={failure.message}
          anchor={failure.anchor}
          onDismiss={() => setFailure(null)}
        />
      ) : null}
    </>
  )
}

export function WorkspaceIdentity({
  activeWorkspace,
  activeWorkspaceId,
  sidebarCollapsed = false,
  onToggleSidebar,
}: {
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
  // The workspace name doubles as a sidebar toggle — it's the workspace's
  // headline, so clicking it shows/hides the workspace list (Cursor idiom). The
  // click always toggles; `sidebarCollapsed` only drives the tooltip/aria
  // wording. When no handler is supplied the name renders as plain text.
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}) {
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setWorkspaceHighlight = useWorkspaceStore((state) => state.setWorkspaceHighlight)
  // For a worktree-backed workspace (a Sprint Engine run in worktree mode, or a
  // worktree opened as a workspace) the branch label AND the change count must
  // reflect the worktree the work runs on — matching the Git panel, which also
  // resolves the worktree. A run_worktree workspace's `folderPath` points at the
  // parent project checkout (e.g. `main`), so probing it reports that checkout's
  // branch and its uncommitted files rather than the worktree's — which is why the
  // count stayed stuck on main's dirty files across branch switches. Resolve the
  // worktree first and probe its `gitRoot`; regular workspaces have no worktree and
  // fall back to `folderPath` unchanged. The folder-path segment still opens the
  // file explorer rooted at `folderPath` — only the git probes move to the worktree.
  const worktree = activeWorkspace ? resolveWorkspaceWorktree(activeWorkspace) : null
  const gitProbePath = worktree?.gitRoot ?? activeWorkspace?.folderPath ?? null
  const gitBranch = useGitBranch(gitProbePath)
  const { status: gitFileStatus, repoState: gitRepoState } = useGitStatus(gitProbePath)
  const branchIsRepo = worktree ? true : gitBranch.isRepo
  const branchName = worktree ? worktree.branch ?? null : gitBranch.branch
  // The git change count that used to badge the (now-removed) Git panel switch
  // rides the branch chip instead — the branch is where "how much has changed"
  // belongs. Same source as the old badge: files in the worktree's status, shown
  // only once the repo has resolved and has uncommitted changes.
  const gitChangeCount = Object.keys(gitFileStatus?.files ?? {}).length
  const gitHasChanges = gitRepoState === 'ready' && gitChangeCount > 0
  const gitChangeLabel = String(Math.min(gitChangeCount, 999))
  // The header identity segments double as panel shortcuts: the folder path
  // toggles the file explorer and the branch toggles the Git panel — same
  // open/close-on-second-click semantics as the Backlog panel switch. Only
  // offered when the owning capability module is enabled, so we never offer a
  // click that resolves to nothing.
  const filesPanelEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
  const gitPanelEnabled = selectModuleEnabled(moduleOverrides, 'git')
  const toggleFilesPanel = React.useCallback(() => {
    if (activeWorkspaceId) toggleNavRailComponent(activeWorkspaceId, 'explorer', 'Files')
  }, [activeWorkspaceId])
  const toggleGitPanel = React.useCallback(() => {
    if (activeWorkspaceId) toggleNavRailComponent(activeWorkspaceId, 'git', 'Git')
  }, [activeWorkspaceId])

  if (!activeWorkspace) return null

  const starred = isStarred(activeWorkspace.highlight)

  // Per-workspace highlight: the retired 48px row tinted its bottom border, but
  // that strip is now the full-width app title bar, where an app-wide bottom
  // tint reads too subtly. Re-home the accent onto the identity cluster itself —
  // the name carries an underline in the highlight colour — so the current
  // workspace's colour stays legible without chroming the whole strip.
  const highlightHex = activeWorkspace.highlight?.color
    ? getHighlightSwatch(activeWorkspace.highlight.color).hex
    : null

  // Show the project's folder name, not the full absolute path — the path was
  // the strip's biggest source of clutter and its only meaningful part is the
  // basename. The full path still rides the chip's tooltip, and the reveal-Files
  // affordance is preserved. Handles POSIX and Windows separators and trailing
  // slashes; falls back to the whole string if there is no separator.
  // The checkout an external editor should open: the mounted worktree when the
  // workspace has one, else the project root — the same resolution the branch
  // chip above and the Git view use, so all three name one tree. Distinct from
  // `folderPath` below, which stays the project root because the Files panel is
  // rooted there.
  const openPath = gitProbePath

  const folderPath = activeWorkspace.folderPath
  const projectName = folderPath
    ? (() => {
        const trimmed = folderPath.replace(/[\\/]+$/, '')
        const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || trimmed
      })()
    : null

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {/*
       * Truncation priority is encoded in flex-shrink factors so the workspace
       * name — the primary identity — yields last: the folder path (shrink-100)
       * collapses first, then the branch (shrink-10), and the name (default
       * shrink-1) keeps its content until the others are exhausted. Each segment
       * grows to its full content when the bar has room; cropping only kicks in
       * as the cluster approaches the right-side controls.
       *
       * The name also carries a `min-w-[7ch]` floor so identity never fully
       * collapses at the 800px window minimum (or the 600px detached width) under
       * a full control load: path and branch still yield to nothing first, but the
       * name keeps a few legible characters instead of shrinking to a single glyph.
       * The floor is only reachable because the right-side controls condense first
       * (WorkspaceActions View→icon-only, win/linux menu bar→hamburger).
       */}
      {/*
       * The name is an interactive chip (same hover treatment as the project and
       * branch chips) that toggles the sidebar — open when collapsed, close when
       * open. When no toggle handler is supplied it degrades to a plain draggable
       * span so the window keeps a grab area and other mount sites still work.
       */}
      {/*
       * The star is its own control, not a passive badge inside the name chip:
       * filled when starred, a quiet outline when not, and clicking it toggles
       * the same `highlight.starred` the sidebar's context menu drives. It
       * replaces the workspace-type icon that used to lead the cluster — when
       * you're already inside the workspace the mode glyph earned nothing, and
       * highlight identity survives on the name's underline.
       */}
      <span
        className="flex min-w-[7ch] items-center gap-0.5"
        style={highlightHex ? { boxShadow: `inset 0 -1.5px 0 ${highlightHex}` } : undefined}
      >
        <Tooltip content={starred ? 'Unstar workspace' : 'Star workspace'} placement="bottom">
          <button
            type="button"
            onClick={() => setWorkspaceHighlight(activeWorkspace.id, { starred: !starred })}
            aria-pressed={starred}
            aria-label={starred ? 'Unstar workspace' : 'Star workspace'}
            className={`app-no-drag interactive group/star flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
          >
            <StarGlyph
              filled={starred}
              stroked={!starred}
              className={`icon-xs shrink-0 transition-colors ${
                starred
                  ? 'text-[color:var(--tone-warn)]'
                  : 'text-[color:var(--text-subtle)] group-hover/star:text-[color:var(--text-default)]'
              }`}
            />
          </button>
        </Tooltip>
        <Tooltip
          content={onToggleSidebar ? (sidebarCollapsed ? 'Open sidebar' : 'Close sidebar') : activeWorkspace.name}
          placement="bottom"
          wrapperClassName="flex min-w-0"
        >
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
              className={`app-no-drag interactive flex min-w-0 items-center rounded-[5px] px-1.5 py-0.5 hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
            >
              <span className="min-w-0 truncate text-body font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
            </button>
          ) : (
            <span className="flex min-w-0 items-center px-1.5 py-0.5">
              <span className="min-w-0 truncate text-body font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
            </span>
          )}
        </Tooltip>
      </span>
      {/*
       * Metadata group: project (folder basename) + branch read as one quiet,
       * muted cluster beside the bold name. Separation is spacing only (the
       * cluster's gap) — no separator dots, so the three segments read as evenly
       * spaced peers rather than one dot sitting between only the first pair.
       * Both segments are subtle chips (hover fill, not a resting border) and opt
       * out of the drag region so they stay clickable.
       */}
      {folderPath ? (
        filesPanelEnabled ? (
          <Tooltip
            content={folderPath}
            placement="bottom"
            wrapperClassName="hidden min-w-0 shrink-[100] md:flex"
          >
            <button
              type="button"
              onClick={toggleFilesPanel}
              aria-label={`Toggle file explorer, ${folderPath}`}
              className={`app-no-drag interactive flex min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-meta text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              <span className="min-w-0 truncate">{projectName}</span>
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[100] items-center gap-1 text-meta text-[color:var(--text-muted)] md:inline-flex">
            <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            <span className="min-w-0 truncate">{projectName}</span>
          </span>
        )
      ) : null}
      {branchIsRepo ? (
        gitPanelEnabled ? (
          <Tooltip
            content={branchName ?? 'Detached HEAD'}
            placement="bottom"
            wrapperClassName="hidden min-w-0 shrink-[10] sm:flex"
          >
            <button
              type="button"
              onClick={toggleGitPanel}
              aria-label={`${branchName ? `Toggle Git panel, branch ${branchName}` : 'Toggle Git panel, detached HEAD'}${
                gitHasChanges ? `, ${gitChangeCount} uncommitted ${gitChangeCount === 1 ? 'change' : 'changes'}` : ''
              }`}
              className={`app-no-drag interactive flex min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-meta text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              <span className="min-w-0 max-w-[22ch] truncate">{branchName ?? 'detached'}</span>
              {gitHasChanges ? (
                <span
                  aria-hidden="true"
                  className="ml-0.5 flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[color:var(--git-count-badge-bg)] px-1.5 text-micro font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]"
                >
                  {gitChangeLabel}
                </span>
              ) : null}
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[10] items-center gap-1 text-meta text-[color:var(--text-muted)] sm:inline-flex">
            <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            <span className="min-w-0 truncate">{branchName ?? 'detached'}</span>
            {gitHasChanges ? (
              <span
                title={`${gitChangeCount} uncommitted ${gitChangeCount === 1 ? 'change' : 'changes'}`}
                className="ml-0.5 flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[color:var(--git-count-badge-bg)] px-1.5 text-micro font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]"
              >
                {gitChangeLabel}
              </span>
            ) : null}
          </span>
        )
      ) : null}
      {/*
       * The one action in this cluster, and the only bordered control in it: the
       * chips above are display segments that happen to toggle a panel, so the
       * border is what separates "opens something outside the app" from them.
       * It sits last, next to the branch it will open — the checkout is what the
       * project and branch segments were describing.
       */}
      {openPath ? (
        <OpenWorkspaceFolderButton workspaceId={activeWorkspaceId} openPath={openPath} />
      ) : null}
    </div>
  )
}
