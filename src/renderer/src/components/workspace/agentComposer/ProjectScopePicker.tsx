import React from 'react'

import { basename } from '../../../utils/paths'
import { showToast } from '../../../store/toastStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { FOCUS_RING_CLASS, Popover } from '../../ui'
import { resolveDefaultParentPath } from '../newWorkspace/folderCreation'
import {
  ProjectSourceMenu,
  type ProjectCloneRequest,
  type ProjectCloneResult,
  type ProjectSourceOption,
} from './ProjectSourceMenu'

// "Which project is this about?", as one chip.
//
// It was a local function inside `NewAgentPanel` until the Design door needed
// the same control: that door opens from the Extensions drawer and silently
// bound to whichever workspace happened to be focused last, so pointing the app
// at a different folder made it claim knowledge of a project the user never
// chose (owner, 2026-09-07). Two surfaces asking the same question have to ask
// it with the same control, so the chip lives here and `ProjectSourceMenu` — the
// searchable body it opens — stays exactly where it was, beside it.
//
// New chat's behaviour is unchanged by the move: same chip, same menu, same
// clone handling, same recents.

/** One choosable project scope: a folder some open workspace lives in. */
export type ProjectScopeOption = ProjectSourceOption

export function ProjectScopePicker({
  label,
  branch,
  options,
  selectedPath,
  onSelect,
  onBrowse,
  onClone,
  importFromGit = true,
  ariaLabel = 'Project this agent runs in',
}: {
  label: string
  /** Checked-out branch, shown after the project name. Null on a door with no checkout. */
  branch: string | null
  options: ProjectScopeOption[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Absent hides the Browse… source (a host with no folder dialog). */
  onBrowse?: () => void
  /**
   * Runs the clone and ADOPTS the result. It lives with the host rather than in
   * the menu: the popover can close mid-clone, and a success that arrived into
   * an unmounted menu used to be lost. Absent falls back to cloning in place.
   */
  onClone?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  /**
   * Whether Import from Git is one of the sources. The Design door says no: its
   * product model is bring/render/point-at, a system is a folder that already
   * exists on the user's disk, and offering to clone one would be a second way
   * in that the epic explicitly cut.
   */
  importFromGit?: boolean
  /** What the trigger is called, for a host whose question is not "which project does this agent run in". */
  ariaLabel?: string
}) {
  // Projects this app knows beyond the ones open in this window: the recent
  // folders the workspace hub lists. Searching the selector covers them too,
  // so a repo opened last week is one keystroke away rather than a Browse.
  const storedRecentFolders = useWorkspaceStore((s) => s.appSettings.recentWorkspaceFolders ?? [])
  const recentOptions = React.useMemo<ProjectScopeOption[]>(() => {
    const open = new Set(options.map((option) => folderPathKey(option.path)))
    const seen = new Set<string>()
    const recents: ProjectScopeOption[] = []
    for (const path of storedRecentFolders) {
      const trimmed = path?.trim()
      if (!trimmed) continue
      const key = folderPathKey(trimmed)
      if (open.has(key) || seen.has(key)) continue
      seen.add(key)
      recents.push({ path: trimmed, label: basename(trimmed) || trimmed })
    }
    return recents
  }, [options, storedRecentFolders])
  // Cold start: nothing open and nothing recent still needs somewhere for a
  // clone to land, so the app's default parent (the hub's own fallback) is
  // asked for once rather than telling the person to open a project first.
  const [fallbackParent, setFallbackParent] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    void window.api.defaultWorkspaceParentDir?.()
      .then((dir) => {
        if (active) setFallbackParent(dir)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  // Where an imported repository lands: beside the current project, else
  // beside the first offered one, else beside a recent one, else the app's
  // default — the same smart-parent resolver the workspace hub uses.
  const defaultParent = resolveDefaultParentPath({
    folderPath: selectedPath,
    recentFolders: [...options.map((option) => option.path), ...storedRecentFolders],
    fallbackParent,
  })
  // A host that runs the clone itself outlives this popover; without one the
  // panel clones in place (the tab-strip host offers no picker, so in practice
  // this is the door with an older host).
  const runClone = React.useCallback(
    async (request: ProjectCloneRequest): Promise<ProjectCloneResult> => {
      if (onClone) return onClone(request)
      const cloned = await window.api
        .cloneGitHubRepo(request)
        .catch((caught: unknown): { ok: false; message: string } => ({
          ok: false,
          message: caught instanceof Error ? caught.message : 'Could not clone the repository.',
        }))
      if (!cloned.ok) return cloned
      showToast({ tone: 'good', title: `Cloned ${basename(cloned.path) || cloned.path}`, description: cloned.path })
      onSelect(cloned.path)
      return { ok: true, path: cloned.path }
    },
    [onClone, onSelect],
  )
  const [open, setOpen] = React.useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          // A stable hook for the Playwright passes (scripts/testing/
          // newChatWorkspace.mjs), which reach the folder through this control.
          data-project-trigger="true"
          // Exactly the machine trigger's box: the scope line is one row of
          // sibling chips, so a `mt-1` left over from when this was the only
          // control on its own line pushed it half a step below the machine
          // dropdown, and a bare `rounded` was an untokenized radius next to
          // its siblings' control radius.
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {label}
          {branch ? ` · ${branch}` : ''}
          <ChevronGlyph />
        </button>
      )}
    >
      {/* Search + sources (remote-sessions-ux / project-selector-sources):
          the selector filters the projects, browses the disk, and steps in
          place into the shipped MC-2207 Git import — one surface, no second
          dialog stacked on the first. */}
      <ProjectSourceMenu
        options={options}
        recentOptions={recentOptions}
        selectedPath={selectedPath}
        defaultParent={defaultParent}
        onSelect={(path) => onSelect(path)}
        onBrowse={onBrowse}
        onClone={importFromGit ? runClone : undefined}
        onClose={() => setOpen(false)}
      />
    </Popover>
  )
}

// One key per folder whatever the separator or trailing slash, so an open
// project and its recent-folders twin count once.
function folderPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function ChevronGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--text-subtle)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6.5 4 3.5 4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
