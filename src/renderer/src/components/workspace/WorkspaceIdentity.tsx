// The active workspace's identity cluster — mode icon, star, name, folder-path
// button, and branch button — hoisted out of the retired 48px WorkspaceTopBar
// row into the merged AppTitleBar title strip (it fills the title bar's centre
// slot). It is a display surface, not a control group, so it sits outside the
// top-bar-group cap (knowledge/brand/panel-design-system.md TopBar inventory).
//
// The folder-path and branch segments double as panel shortcuts (reveal Files /
// Git) when the owning capability module is enabled; those two buttons opt out
// of the title strip's drag region with `app-no-drag`, while the non-interactive
// icon/star/name stay draggable to preserve the window grab area.

import React from 'react'
import { WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { FOCUS_RING_CLASS, StarGlyph, Tooltip, TruncatedText } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitBranch } from '../../hooks/useGitBranch'
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

export function WorkspaceIdentity({
  activeWorkspace,
  activeWorkspaceId,
}: {
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
}) {
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const gitBranch = useGitBranch(activeWorkspace?.folderPath ?? null)
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

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span
        className={`shrink-0 ${highlightHex ? '' : workspaceTabIconClass(activeWorkspace.mode, moduleOverrides)}`}
        style={{ color: highlightHex ?? undefined }}
      >
        <WorkspaceTypeIcon mode={activeWorkspace.mode} moduleOverrides={moduleOverrides} className="icon-sm" />
      </span>
      {activeWorkspace.highlight?.starred ? (
        <StarGlyph filled className="icon-xs shrink-0 text-[color:var(--tone-warn)]" label="Starred workspace" />
      ) : null}
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
      <span
        className="flex min-w-[7ch]"
        style={highlightHex ? { boxShadow: `inset 0 -1.5px 0 ${highlightHex}` } : undefined}
      >
        <TruncatedText
          as="span"
          text={activeWorkspace.name}
          placement="bottom"
          className="min-w-0 text-[13px] font-semibold text-[color:var(--text-strong)]"
        />
      </span>
      {activeWorkspace.folderPath ? (
        filesPanelEnabled ? (
          <Tooltip
            content={activeWorkspace.folderPath}
            placement="bottom"
            wrapperClassName="hidden min-w-0 shrink-[100] md:flex"
          >
            <button
              type="button"
              onClick={revealFilesPanel}
              aria-label={`Open file explorer, ${activeWorkspace.folderPath}`}
              className={`app-no-drag interactive min-w-0 truncate text-left text-[12px] text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              · {activeWorkspace.folderPath}
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[100] truncate text-[12px] text-[color:var(--text-disabled)] md:inline">
            · {activeWorkspace.folderPath}
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
              aria-label={branchName ? `Open Git panel, branch ${branchName}` : 'Open Git panel, detached HEAD'}
              className={`app-no-drag interactive flex min-w-0 items-center gap-1 text-[12px] text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              <GitBranchGlyph className="icon-xs shrink-0" />
              <span className="min-w-0 max-w-[22ch] truncate">{branchName ?? 'detached'}</span>
            </button>
          </Tooltip>
        ) : (
          <span className="hidden min-w-0 shrink-[10] items-center gap-1 text-[12px] text-[color:var(--text-muted)] sm:inline-flex">
            <GitBranchGlyph className="icon-xs shrink-0" />
            <span className="min-w-0 truncate">{branchName ?? 'detached'}</span>
          </span>
        )
      ) : null}
    </div>
  )
}
