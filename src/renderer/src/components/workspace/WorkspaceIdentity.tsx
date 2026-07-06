// The active workspace's identity cluster — mode icon, star, name, project
// (folder-name) chip, and branch chip — hoisted out of the retired 48px WorkspaceTopBar
// row into the merged AppTitleBar title strip (it fills the title bar's centre
// slot). It is a display surface, not a control group, so it sits outside the
// top-bar-group cap (knowledge/brand/panel-design-system.md TopBar inventory).
//
// The project and branch segments double as panel shortcuts (reveal Files /
// Git) when the owning capability module is enabled; those two buttons opt out
// of the title strip's drag region with `app-no-drag`, while the non-interactive
// icon/star/name stay draggable to preserve the window grab area.

import React from 'react'
import { WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { FOCUS_RING_CLASS, StarGlyph, Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useGitStatus } from '../../hooks/useGitStatus'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { selectModuleEnabled } from '../../modules'
import { getHighlightSwatch } from '../../utils/highlight'
import { revealNavRailComponent } from '../../utils/modelRegistry'
import type { Workspace } from '../../types/workspace'

// Tab accent comes from the enabled workspace type's accentToken; a disabled
// module, an unknown id, or shell-owned 'standard' falls back to the muted
// default. Matches the prior per-mode mapping for the bundled types while
// degrading disabled-module workspaces to the generic accent.
function workspaceTabIconClass(mode: Workspace['mode'], moduleOverrides: ModuleEnablementOverrides): string {
  const token = resolveEnabledWorkspaceType(mode, moduleOverrides)?.accentToken ?? '--text-muted'
  return `text-[color:var(${token})]`
}

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
  const gitBranch = useGitBranch(activeWorkspace?.folderPath ?? null)
  const { status: gitFileStatus, repoState: gitRepoState } = useGitStatus(
    activeWorkspace?.folderPath ?? null
  )
  // For a worktree-backed workspace (a Sprint Engine run in worktree mode, or a
  // worktree opened as a workspace) the branch label must reflect the worktree
  // the work runs on — matching the Git panel, which also resolves the worktree.
  // The live `useGitBranch` probe is keyed on the parent `folderPath` and reports
  // its branch (e.g. "main"), so prefer the worktree's branch, which is available
  // synchronously from workspace state and is symlink-independent. The folder-path
  // segment stays on `folderPath` because it opens the file explorer, which is
  // rooted there. Regular workspaces fall back to the live probe unchanged.
  const worktree = activeWorkspace ? resolveWorkspaceWorktree(activeWorkspace) : null
  const branchIsRepo = worktree ? true : gitBranch.isRepo
  const branchName = worktree ? worktree.branch ?? null : gitBranch.branch
  // The git change count that used to badge the (now-removed) Git panel switch
  // rides the branch chip instead — the branch is where "how much has changed"
  // belongs. Same source as the old badge: files in the workspace folder's
  // status, shown only once the repo has resolved and has uncommitted changes.
  const gitChangeCount = Object.keys(gitFileStatus?.files ?? {}).length
  const gitHasChanges = gitRepoState === 'ready' && gitChangeCount > 0
  const gitChangeLabel = String(Math.min(gitChangeCount, 999))
  // The header identity segments double as panel shortcuts: the folder path
  // reveals the file explorer and the branch reveals the Git panel — but only
  // when the owning capability module is enabled, so we never offer a click that
  // resolves to nothing.
  const filesPanelEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
  const gitPanelEnabled = selectModuleEnabled(moduleOverrides, 'git')
  const revealFilesPanel = React.useCallback(() => {
    if (activeWorkspaceId) revealNavRailComponent(activeWorkspaceId, 'explorer', 'Files')
  }, [activeWorkspaceId])
  const revealGitPanel = React.useCallback(() => {
    if (activeWorkspaceId) revealNavRailComponent(activeWorkspaceId, 'git', 'Git')
  }, [activeWorkspaceId])

  if (!activeWorkspace) return null

  // Per-workspace highlight: the retired 48px row tinted its bottom border, but
  // that strip is now the full-width app title bar, where an app-wide bottom
  // tint reads too subtly. Re-home the accent onto the identity cluster itself —
  // the mode icon takes the highlight hex and the name carries a matching
  // underline — so the current workspace's colour stays legible without chroming
  // the whole strip.
  const highlightHex = activeWorkspace.highlight?.color
    ? getHighlightSwatch(activeWorkspace.highlight.color).hex
    : null

  // Show the project's folder name, not the full absolute path — the path was
  // the strip's biggest source of clutter and its only meaningful part is the
  // basename. The full path still rides the chip's tooltip, and the reveal-Files
  // affordance is preserved. Handles POSIX and Windows separators and trailing
  // slashes; falls back to the whole string if there is no separator.
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
      <span
        className="flex min-w-[7ch]"
        style={highlightHex ? { boxShadow: `inset 0 -1.5px 0 ${highlightHex}` } : undefined}
      >
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
              className={`app-no-drag interactive flex min-w-0 items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 hover:bg-[color:var(--bg-hover)] ${FOCUS_RING_CLASS}`}
            >
              <span
                className={`shrink-0 ${highlightHex ? '' : workspaceTabIconClass(activeWorkspace.mode, moduleOverrides)}`}
                style={{ color: highlightHex ?? undefined }}
              >
                <WorkspaceTypeIcon mode={activeWorkspace.mode} moduleOverrides={moduleOverrides} className="icon-sm" />
              </span>
              {activeWorkspace.highlight?.starred ? (
                <StarGlyph filled className="icon-xs shrink-0 text-[color:var(--tone-warn)]" label="Starred workspace" />
              ) : null}
              <span className="min-w-0 truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
            </button>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={`shrink-0 ${highlightHex ? '' : workspaceTabIconClass(activeWorkspace.mode, moduleOverrides)}`}
                style={{ color: highlightHex ?? undefined }}
              >
                <WorkspaceTypeIcon mode={activeWorkspace.mode} moduleOverrides={moduleOverrides} className="icon-sm" />
              </span>
              {activeWorkspace.highlight?.starred ? (
                <StarGlyph filled className="icon-xs shrink-0 text-[color:var(--tone-warn)]" label="Starred workspace" />
              ) : null}
              <span className="min-w-0 truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
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
              onClick={revealFilesPanel}
              aria-label={`Open file explorer, ${folderPath}`}
              className={`app-no-drag interactive flex min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[12px] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              <span className="min-w-0 truncate">{projectName}</span>
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[100] items-center gap-1 text-[12px] text-[color:var(--text-muted)] md:inline-flex">
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
              onClick={revealGitPanel}
              aria-label={`${branchName ? `Open Git panel, branch ${branchName}` : 'Open Git panel, detached HEAD'}${
                gitHasChanges ? `, ${gitChangeCount} uncommitted ${gitChangeCount === 1 ? 'change' : 'changes'}` : ''
              }`}
              className={`app-no-drag interactive flex min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[12px] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              <span className="min-w-0 max-w-[22ch] truncate">{branchName ?? 'detached'}</span>
              {gitHasChanges ? (
                <span
                  aria-hidden="true"
                  className="ml-0.5 flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-[color:var(--git-count-badge-bg)] px-1 text-[9px] font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]"
                >
                  {gitChangeLabel}
                </span>
              ) : null}
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[10] items-center gap-1 text-[12px] text-[color:var(--text-muted)] sm:inline-flex">
            <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            <span className="min-w-0 truncate">{branchName ?? 'detached'}</span>
            {gitHasChanges ? (
              <span
                title={`${gitChangeCount} uncommitted ${gitChangeCount === 1 ? 'change' : 'changes'}`}
                className="ml-0.5 flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-[color:var(--git-count-badge-bg)] px-1 text-[9px] font-bold leading-none tabular-nums text-[color:var(--git-count-badge-ink)]"
              >
                {gitChangeLabel}
              </span>
            ) : null}
          </span>
        )
      ) : null}
    </div>
  )
}
