import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useGitStatus, useGitTreeRevision, type GitRepoState } from '../../hooks/useGitStatus'
import { useChangelists } from '../../hooks/useChangelists'
import { hunkKey, hunkToggleScope, type GitHunkView } from '../../../../shared/git/hunks'
import {
  hunkOwnerId,
  normalizeChangelistPath,
  pathsOfChangelist,
  type Changelist,
} from '../../../../shared/git/changelists'
import { detectLanguage, isImageFile } from '../../utils/files'
import { joinFilePath } from '../../utils/paths'
import { BranchStepStrip, BRANCH_STEP_PANEL_ID } from './BranchStepStrip'
import { branchItemsFrom, scopeNote, stripEntriesFrom, type BranchDiffItem } from './branchSteps'
import { useBranchSteps } from './useBranchSteps'
import { MONO_FONT_STACK, remeasureWhenMonoFontLoads } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { buildDiffFileList, findDiffFocusIndex, type DiffFileItem } from './diffFileList'
import { navigateFile, nextDiffPosition, resolveEdgeHunkIndex, takesNavigationKey } from './diffNavigation'
import {
  Checkbox,
  CollapseAllGlyph,
  EmptyState,
  FileTypeGlyph,
  GearGlyph,
  InlineNotice,
  MenuItem,
  MicroChip,
  NextDifferenceGlyph,
  OpenInEditorGlyph,
  OutlineButton,
  Pager,
  Popover,
  PreviousDifferenceGlyph,
  SegmentedControl,
  Select,
  SideBySideGlyph,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  ToolbarSpacer,
  Tooltip,
  UnifiedGlyph,
  roveMenuFocus,
} from '../ui'
import { MENU_LIST_CLASS } from '../ui/menuClasses'
import { FOCUS_RING_INSET_CLASS } from '../ui/tokens'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'
import { openDiffWindow } from './openDiffWindow'
import { openExternalFileWindow } from './openFileWindow'
import { openFileSurface } from '../../utils/openFileSurface'
import { configureMonacoLanguages } from '../../utils/patchLanguage'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { writeAuxWindowSetting } from './auxSettingsWrite'
import { getGitEntry } from '../../hooks/useGitStatus'
import type { DiffViewMode } from '../../store/slices/settingsSlice'
import { hunkGutterLine } from '../../../../shared/git/hunks'
import { HunkGutter, GLYPH_MARGIN_LANE_CENTER, type GlyphMarginHost } from './HunkGutter'
import { hunkBoxes, hunkFileKey } from './hunkGutterModel'
import { useFileHunks } from './useFileHunks'
import {
  DEFAULT_DIFF_EDITOR_PREFS,
  diffEditorOptions,
  differenceCounterLabel,
  headerStripModel,
  includeAction,
  includeBoxState,
  isIncludable,
  liveDiffEditorOptions,
  type DiffEditorPrefs,
  type IncludeBoxState,
} from './diffToolbarModel'

// The diff viewer: the changed-file list, a read-only Monaco DiffEditor, and
// hunk navigation that flows across files. Two hosts render it — the
// standalone aux window (DiffViewerWindow) and the workspace pane's Diff tab
// (browser-pane epic) — and the only thing that differs is the band above it:
// the window draws a title bar with the traffic-light inset and closes on
// Escape; the pane draws a panel-header band with an "Open in separate
// window" action and scopes its arrow keys to itself.
//
// Those two band actions are also the sticky preference's only writers
// (git-commit-window T3): opening a diff in the window says "this is where
// diffs go", showing it in the app says the opposite, and the next Git row
// obeys that remembered choice. There is no drag-a-tab-out gesture in
// the pane strip for any kind, so the buttons ARE the gesture.

export type DiffViewerVariant = 'window' | 'pane'

type Props = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
  /**
   * Show only one changelist's files (`agent:<agentId>`, agent changelists).
   * Null/absent is "All changes" and is the whole of the pre-changelist
   * behaviour: no extra read, no extra chrome, the same file list.
   *
   * It is the filter the viewer OPENS on, not the filter it is stuck with — the
   * header strip's select is the person's copy of it, and a list that has since
   * been deleted degrades to all changes with the strip saying so.
   */
  changelistId?: string | null
  /**
   * The workspace this diff belongs to. The pane host knows it outright; the
   * window host carries it as a URL param so "Show in the app" can name the
   * pane it hands the diff back to. Null in a window opened before the param
   * existed — the action hides rather than guessing a workspace.
   */
  workspaceId?: string | null
  variant?: DiffViewerVariant
  /** Pane host only: the canonical count of the view, for the tab strip; null once the viewer is gone. */
  onItemCountChange?: (count: number | null) => void
  /**
   * Show the branch's commits as steps above the file list
   * (the-diff-an-agent-made / changed-files-and-commit-steps). Pane only: the
   * aux window is opened on one file from the working tree and has no branch to
   * step through.
   */
  branchSteps?: boolean
}

type DiffContent =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'binary' }
  | { state: 'too-large' }
  | { state: 'ready'; original: string; modified: string; language: string }

const NUL = '\u0000'

/** The changelist select's "no filter" option. Not a list id — the model has no
 *  id for "everything", and inventing one would put a phantom list in front of
 *  every function that takes one. */
const ALL_CHANGES = '__all-changes__'

// Two reads of the same file that say the same thing. The live re-read below
// drops a result that matches what is on screen, so an unchanged file costs two
// file reads and no render — no model reset, no scroll jump, no diff recompute.
function sameDiffContent(a: DiffContent, b: DiffContent): boolean {
  if (a.state !== b.state) return false
  if (a.state === 'ready' && b.state === 'ready') {
    return a.original === b.original && a.modified === b.modified && a.language === b.language
  }
  if (a.state === 'error' && b.state === 'error') return a.message === b.message
  return true
}

const STATUS_LABEL: Record<DiffFileItem['status'], string> = {
  new: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted',
}

// Reads one stage side of the diff from Git. A missing object resolves to empty
// content (new file → empty original; staged deletion → empty modified) rather
// than an error.
async function readStageSide(
  repoRoot: string,
  path: string,
  stage: 'head' | 'index',
): Promise<{ content: string; binary: boolean; tooLarge: boolean } | { error: string }> {
  const result = await window.api.getGitFileAtStage(repoRoot, path, stage)
  if (!result.ok) return { error: result.message }
  return { content: result.content, binary: result.binary, tooLarge: result.tooLarge }
}

/**
 * Stage (or unstage) exactly the hunks a changelist owns in one file.
 *
 * One `git apply` per hunk, in arrival order, stopping at the first refusal so
 * the person is told about the hunk that actually failed rather than about the
 * last one. Hunks whose state already matches the direction are skipped, which
 * is what makes a second click on a half-done file finish it instead of
 * flipping the half that was already there.
 *
 * There is no batched IPC for this and there deliberately is not one: main
 * finds a hunk by re-reading the diff at that instant (`git-hunks.ts`), so a
 * batch would be a list of fingerprints against a file that moved under it
 * halfway through. Sequential calls each read the file as it is now.
 */
async function stageOwnedHunks(input: {
  repoRoot: string
  filePath: string
  hunks: GitHunkView[]
  action: 'stage' | 'unstage'
}): Promise<{ ok: boolean; message?: string | null; stderr?: string | null }> {
  const wanted = input.action === 'stage'
  const targets = input.hunks.filter((hunk) => hunk.included !== wanted)
  for (const hunk of targets) {
    const ref = {
      repoRoot: input.repoRoot,
      filePath: input.filePath,
      scope: hunkToggleScope(hunk),
      index: hunk.index,
      fingerprint: hunk.fingerprint,
    }
    const result = wanted ? await window.api.stageGitHunk(ref) : await window.api.unstageGitHunk(ref)
    if (!result.ok) return result
  }
  return { ok: true }
}

// Reads the working-tree side off disk. A deleted-on-disk file (unstaged
// deletion) resolves to an empty modified pane.
async function readWorktreeSide(path: string): Promise<{ content: string; binary: boolean }> {
  try {
    const content = await window.api.readfile(path)
    return { content, binary: content.includes(NUL) }
  } catch {
    return { content: '', binary: false }
  }
}

// One side of a commit step, read at a revision. A revision of null means the
// file was not there — an addition's original, a deletion's modified — and the
// honest render for that is an empty pane, not a read failure. `absent` from
// main means the same thing and is rendered the same way.
async function readRevSide(
  repoRoot: string,
  path: string,
  rev: string | 'worktree' | null,
): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  if (rev === null) return { content: '', binary: false, tooLarge: false }
  if (rev === 'worktree') {
    const worktree = await readWorktreeSide(joinFilePath(repoRoot, path))
    return { ...worktree, tooLarge: false }
  }
  const result = await window.api.getGitFileAtRev(repoRoot, rev, path)
  if (result.kind === 'too-large') return { content: '', binary: false, tooLarge: true }
  if (result.kind === 'absent') return { content: '', binary: false, tooLarge: false }
  return { content: result.content, binary: result.content.includes(NUL), tooLarge: false }
}

async function loadDiffContent(repoRoot: string, item: DiffFileItem): Promise<DiffContent> {
  const language = detectLanguage(item.relativePath)

  if (isImageFile(item.path) || isImageFile(item.relativePath)) {
    return { state: 'binary' }
  }

  if (item.kind === 'branch') {
    const branch = item as BranchDiffItem
    const [original, modified] = await Promise.all([
      readRevSide(repoRoot, branch.relativePath, branch.originalRev),
      readRevSide(repoRoot, branch.relativePath, branch.modifiedRev),
    ])
    if (original.tooLarge || modified.tooLarge) return { state: 'too-large' }
    if (original.binary || modified.binary) return { state: 'binary' }
    return { state: 'ready', original: original.content, modified: modified.content, language }
  }

  if (item.kind === 'staged') {
    const [head, index] = await Promise.all([
      readStageSide(repoRoot, item.path, 'head'),
      readStageSide(repoRoot, item.path, 'index'),
    ])
    if ('error' in head) return { state: 'error', message: head.error }
    if ('error' in index) return { state: 'error', message: index.error }
    if (head.tooLarge || index.tooLarge) return { state: 'too-large' }
    if (head.binary || index.binary) return { state: 'binary' }
    return { state: 'ready', original: head.content, modified: index.content, language }
  }

  // unstaged: original = index (committed/staged baseline), modified = worktree.
  const [index, worktree] = await Promise.all([
    readStageSide(repoRoot, item.path, 'index'),
    readWorktreeSide(item.path),
  ])
  if ('error' in index) return { state: 'error', message: index.error }
  if (index.tooLarge) return { state: 'too-large' }
  if (index.binary || worktree.binary) return { state: 'binary' }
  return { state: 'ready', original: index.content, modified: worktree.content, language }
}

// The two buttons that write the sticky `diffOpensInWindow` preference
// (git-commit-window T3). They moved into the toolbar band in T4 and kept
// everything else: the same handlers, the same tooltips, the same rule that
// each one is the whole gesture for "diffs belong here now". Losing either
// would leave the preference with no writer at all.
function OpenInWindowButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Open in separate window" placement="bottom">
      <ToolbarButton ariaLabel="Open in separate window" onClick={onClick}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path
            d="M6.5 3H3v10h10V9.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 3H13v3.5M13 3 7.5 8.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ToolbarButton>
    </Tooltip>
  )
}

// The window's way home: the same diff in the pane's Diff tab, and the sticky
// preference flipped so the next one opens there too. Its neighbour is Escape,
// which only closes the window and decides nothing — the tooltip says so,
// because "close" and "put it back" are different intentions.
function ShowInAppButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Show in the app (Esc just closes this window)" placement="bottom">
      <ToolbarButton ariaLabel="Show in the app" onClick={onClick}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3v10" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </ToolbarButton>
    </Tooltip>
  )
}

/**
 * The gear: the two reading options that are not worth a band item each — word
 * wrap and whether whitespace-only changes count. Grouping them keeps the
 * reading controls together. `ToolbarButton menu` draws the corner triangle and says
 * `aria-haspopup`; the rows are the kit's `menuitemcheckbox`, because each one
 * is a state and not an action.
 */
function DiffSettingsMenu({
  prefs,
  onChange,
}: {
  prefs: DiffEditorPrefs
  onChange: (patch: Partial<DiffEditorPrefs>) => void
}) {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Diff settings"
      popupRole="menu"
      placement="bottom-end"
      onOpenAutoFocus={(surface) => {
        surfaceRef.current = surface
        surface.querySelector<HTMLButtonElement>('[data-menu-item="true"]')?.focus()
      }}
      surfaceClassName={`min-w-[11rem] ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, togglePopover }) => (
        <Tooltip content="Diff settings" placement="bottom">
          <ToolbarButton ref={ref} ariaLabel="Diff settings" menu expanded={open} onClick={togglePopover}>
            <GearGlyph />
          </ToolbarButton>
        </Tooltip>
      )}
    >
      <MenuItem
        checked={prefs.wordWrap}
        onClick={() => onChange({ wordWrap: !prefs.wordWrap })}
        onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
      >
        Word wrap
      </MenuItem>
      <MenuItem
        checked={prefs.ignoreTrimWhitespace}
        onClick={() => onChange({ ignoreTrimWhitespace: !prefs.ignoreTrimWhitespace })}
        onKeyDown={(event) => roveMenuFocus(event, surfaceRef.current)}
      >
        Ignore whitespace
      </MenuItem>
    </Popover>
  )
}

// The aux window's empty states were their own dialect: bare centred
// mono text, no CTA, and copy a person is meant to READ rendered in
// `--text-disabled` — the ink of a dead control. They are the kit's `EmptyState`
// now; a failure is the kit's notice, because a failure is not an empty state.
function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <EmptyState title={children} />
}

function CenteredError({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <InlineNotice tone="error" className="max-w-md">
        {message}
      </InlineNotice>
    </div>
  )
}

/**
 * What the content becomes while the NEXT file's diff is being read.
 *
 * The answer is "the file you were looking at", and that is the whole of
 * finding 13. Routing a file step through `{ state: 'loading' }` made
 * `DiffBody` return the message component instead of the editor, which is a
 * different element type — so React unmounted Monaco and mounted it again on
 * every press of ↓. The live re-read path never did this: it swaps the two
 * texts under a mounted editor, and a file step is the same move with a
 * different pair of texts.
 *
 * A message is still the right answer where there is no editor to keep: the
 * first read of a window, and a step into another repository, where the diff on
 * screen is not merely stale but about somewhere else.
 */
export function contentAcrossTargetChange(previous: DiffContent, sameRepo: boolean): DiffContent {
  return previous.state === 'ready' && sameRepo ? previous : { state: 'loading' }
}

/**
 * Exported for `DiffViewer.remount.test.tsx`, which calls it as a plain
 * function (it holds no hooks, deliberately) and reads the element it returns.
 * Two calls whose only difference is a view preference must return an element
 * of the same `type` and the same `key` — that, and nothing else, is what
 * decides whether React remounts Monaco.
 */
export function DiffBody({
  content,
  repoState,
  currentItem,
  onMount,
  monacoTheme,
  options,
  stepLoading,
}: {
  content: DiffContent
  repoState: GitRepoState
  currentItem: DiffFileItem | null
  onMount: DiffOnMount
  monacoTheme: 'vs' | 'vs-dark'
  /** The construction options, already carrying the current preferences. */
  options: Monaco.editor.IStandaloneDiffEditorConstructionOptions
  /** A branch step's file list is still being read. */
  stepLoading?: boolean
}) {
  if (repoState === 'not-git') return <CenteredMessage>Not a Git repository.</CenteredMessage>
  if (!currentItem) {
    if (repoState === 'loading' || repoState === 'idle') return <CenteredMessage>Loading changes…</CenteredMessage>
    // `repoState` goes ready as soon as `git status` returns, which is well
    // before a step's own diff resolves. Without this the pane asserts "No
    // changed files." — confidently, and wrongly — for the whole of that read.
    if (stepLoading) return <CenteredMessage>Loading changes…</CenteredMessage>
    return <CenteredMessage>No changed files.</CenteredMessage>
  }
  if (content.state === 'loading') return <CenteredMessage>Loading diff…</CenteredMessage>
  if (content.state === 'error') return <CenteredError message={content.message} />
  if (content.state === 'binary') return <CenteredMessage>Binary file — diff not shown.</CenteredMessage>
  if (content.state === 'too-large') return <CenteredMessage>File is too large to diff.</CenteredMessage>

  return (
    <DiffEditor
      height="100%"
      beforeMount={configureMonacoLanguages}
      theme={monacoTheme}
      original={content.original}
      modified={content.modified}
      language={content.language}
      // The wrapper disposes the models BEFORE the editor on unmount, and
      // Monaco 0.55's diff widget asserts on a model that vanishes under it
      // ("TextModel got disposed before DiffEditorWidget model got reset").
      // Keep them, and dispose them after the editor is gone (see onMount).
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      // NO `key` here, and none above: the view preferences reach Monaco
      // through `options` at construction and through `editor.updateOptions`
      // afterwards (diffToolbarModel), never through a new element. A key that
      // moved with the toggle would dispose the models under the diff widget
      // mid-reset — the exact failure the workaround above exists for.
      options={options}
      onMount={onMount}
    />
  )
}

export function DiffViewer({
  repoRoot,
  focusPath,
  focusKind,
  changelistId = null,
  workspaceId = null,
  variant = 'window',
  onItemCountChange,
  branchSteps = false,
}: Props) {
  const { status, repoState, repoRoot: gitRoot, refresh: refreshGitStatus } = useGitStatus(repoRoot)
  // Ticks once per completed status read of this repository — the cue that the
  // working tree moved under the open file. Given the RESOLVED root so it joins
  // the subscription the line above already opened.
  const treeRevision = useGitTreeRevision(gitRoot)
  const isMac = window.api.platform === 'darwin'
  const monacoTheme = useMonacoBaseTheme()

  // The branch's steps, re-read when the git watcher says the tree moved. The
  // status snapshot is the revision token: a rebase or a commit changes it, and
  // a strip held across one would be confidently wrong about hashes that no
  // longer exist.
  const steps = useBranchSteps(repoRoot, branchSteps, status)
  const stripEntries = useMemo(() => stripEntriesFrom(steps.snapshot), [steps.snapshot])
  const stepNote = useMemo(() => scopeNote(steps.snapshot), [steps.snapshot])
  // ── The changelist filter ───────────────────────────────────────────────
  //
  // The viewer OPENS on `changelistId` and the person owns it from there: the
  // strip's select is the only writer, so "show me all changes" is one click
  // and never a reopen. The prop still wins whenever the host changes it (a
  // retarget, a new tab), which is what `chosenFilter.from` compares.
  //
  // The lists are read only when there IS a filter. That is the whole of "no
  // changelist means today's behaviour, byte for byte": an ordinary diff makes
  // no changelist IPC call, draws no select, and labels no hunk.
  const filtering = Boolean(changelistId)
  const { changelists, refresh: refreshChangelists } = useChangelists(filtering ? gitRoot : null)
  const [chosenFilter, setChosenFilter] = useState<{ from: string | null; id: string | null }>(() => ({
    from: changelistId ?? null,
    id: changelistId ?? null,
  }))
  const filterId = chosenFilter.from === (changelistId ?? null) ? chosenFilter.id : (changelistId ?? null)
  const filterList = filterId ? (changelists.find((list) => list.id === filterId) ?? null) : null

  // "Not read yet" and "gone" are the same shape — a list that is not in the
  // array — and they must not be told apart by guessing. The first completed
  // read is the moment the difference becomes real, so nothing is called gone
  // before it, and until then the filter is honoured with an EMPTY list rather
  // than by falling back to the whole repository: a window opened on an agent's
  // list must not flash every file in the checkout before narrowing to seven.
  const [listsRead, setListsRead] = useState(false)
  useEffect(() => {
    if (!filtering || !gitRoot) return
    let live = true
    void refreshChangelists().then(() => {
      if (live) setListsRead(true)
    })
    return () => {
      live = false
    }
  }, [filtering, gitRoot, refreshChangelists])
  // A repository that is not one never gets a changelist read, so "the lists
  // have not landed" would be forever there; the viewer's own answer about the
  // repository is the one worth showing.
  const filterReadable = repoState !== 'not-git' && repoState !== 'error'
  const filterPending = Boolean(filterId) && !filterList && !listsRead && filterReadable
  const filterMissing = Boolean(filterId) && !filterList && (listsRead || !filterReadable)
  const pendingList = useMemo<Changelist | null>(
    () => (filterPending && filterId ? { id: filterId, name: '', paths: [], active: false } : null),
    [filterPending, filterId],
  )
  const showAllChanges = useCallback(() => {
    setChosenFilter({ from: changelistId ?? null, id: null })
  }, [changelistId])

  const workingItems = useMemo(
    () => buildDiffFileList(status, { changelist: filterList ?? pendingList }),
    [status, filterList, pendingList],
  )
  const unfilteredBranchItems = useMemo(
    () => branchItemsFrom(steps.diff, steps.selection, steps.snapshot, repoRoot),
    [steps.diff, steps.selection, steps.snapshot, repoRoot],
  )
  // The pane steps through the BRANCH, and its file list is a step's diff, not
  // git status — so the filter has to be applied here too, or the pane shows
  // the right name in the select over the whole checkout's files. It applies to
  // the WORKING-TREE step only: a changelist describes uncommitted lines, and
  // a commit is a step the list has already been pruned out of, so filtering
  // history by it would show an empty commit under an agent's name.
  const branchItems = useMemo(() => {
    const list = filterList ?? pendingList
    if (!list) return unfilteredBranchItems
    const owned = new Set(pathsOfChangelist(list))
    return unfilteredBranchItems.filter(
      (item) => item.modifiedRev !== 'worktree' || owned.has(normalizeChangelistPath(item.relativePath)),
    )
  }, [unfilteredBranchItems, filterList, pendingList])
  // Whether what the pane is showing is the working tree at all — the one step
  // the filter can empty honestly.
  const branchShowsWorktree = unfilteredBranchItems.some((item) => item.modifiedRev === 'worktree')
  const items = branchSteps ? branchItems : workingItems

  useEffect(() => {
    onItemCountChange?.(items.length)
  }, [items.length, onItemCountChange])
  useEffect(() => () => onItemCountChange?.(null), [onItemCountChange])

  const [currentIndex, setCurrentIndex] = useState(-1)
  const initializedRef = useRef(false)
  const currentPathKeyRef = useRef<string | null>(null)
  // The PATH alone, without the kind. Including a file moves it between the
  // staged and unstaged groups — the entry the key names disappears and a new
  // one for the same file appears — so this is what the anchor falls back to
  // before it gives up and clamps to a neighbour (T4: the include box must not
  // walk the person off the file they just included).
  const currentPathRef = useRef<string | null>(null)

  // Initialise focus once the first status snapshot arrives, then keep the cursor
  // anchored to the same (path, kind) as the list changes underneath us (file
  // saved / staged). If the focused entry disappears, clamp into range.
  useEffect(() => {
    if (items.length === 0) {
      setCurrentIndex(-1)
      currentPathKeyRef.current = null
      currentPathRef.current = null
      return
    }
    if (!initializedRef.current) {
      const index = findDiffFocusIndex(items, focusPath, focusKind)
      const resolved = index >= 0 ? index : 0
      initializedRef.current = true
      setCurrentIndex(resolved)
      currentPathKeyRef.current = keyFor(items[resolved])
      currentPathRef.current = items[resolved]?.path ?? null
      return
    }
    const previousKey = currentPathKeyRef.current
    const keptIndex = previousKey ? items.findIndex((item) => keyFor(item) === previousKey) : -1
    if (keptIndex >= 0) {
      if (keptIndex !== currentIndex) setCurrentIndex(keptIndex)
      currentPathRef.current = items[keptIndex]?.path ?? null
      return
    }
    // Same file, other group: including or excluding the open file is the one
    // thing that reliably does this, and following it is what makes the header
    // strip's checkbox feel like a checkbox rather than a jump.
    const previousPath = currentPathRef.current
    const samePathIndex = previousPath ? items.findIndex((item) => item.path === previousPath) : -1
    if (samePathIndex >= 0) {
      if (samePathIndex !== currentIndex) setCurrentIndex(samePathIndex)
      currentPathKeyRef.current = keyFor(items[samePathIndex])
      return
    }
    const clamped = Math.min(Math.max(currentIndex, 0), items.length - 1)
    setCurrentIndex(clamped)
    currentPathKeyRef.current = keyFor(items[clamped])
    currentPathRef.current = items[clamped]?.path ?? null
  }, [items, focusPath, focusKind, currentIndex])

  const currentItem = currentIndex >= 0 ? (items[currentIndex] ?? null) : null

  const [content, setContent] = useState<DiffContent>({ state: 'loading' })
  // Read by the target effect, which has to know what is on screen without
  // depending on it — depending on `content` would re-read the diff every time
  // the diff was read.
  const contentRef = useRef<DiffContent>(content)
  contentRef.current = content
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  // The MODIFIED editor and the lane its glyph margin hangs widgets in — the
  // two things the per-hunk include boxes need (T7). State rather than a ref
  // because the boxes are React's to render and must appear when Monaco does.
  const [gutterHost, setGutterHost] = useState<{ editor: GlyphMarginHost; lane: number } | null>(null)
  // Where the stepper stops, in order down the file. TWO sources, and which is
  // authoritative is finding 9: the counter reads git's `-U0` hunks while the
  // stepper read Monaco's `getLineChanges()`, and with `ignoreTrimWhitespace`
  // on Monaco can find nothing to step through in a file the counter says has
  // two differences — so ↓ walked straight past it. git's hunks win whenever
  // git has answered; Monaco's are the fallback for the files git has no hunks
  // for (a branch step, a file whose read has not landed).
  const monacoStepsRef = useRef<DiffStep[]>([])
  const gitStepsRef = useRef<DiffStep[] | null>(null)
  const diffSteps = (): DiffStep[] => gitStepsRef.current ?? monacoStepsRef.current
  const hunkIndexRef = useRef(0)
  const pendingEdgeRef = useRef<'first' | 'last' | null>(null)

  // A retarget after the first snapshot — the pane's Git tab activating another
  // row while the viewer is mounted — moves the cursor without a remount:
  // remounting disposes Monaco's models under the diff widget mid-reset.
  const focusKeyRef = useRef(`${focusPath ?? ''}::${focusKind ?? ''}`)
  useEffect(() => {
    const focusKey = `${focusPath ?? ''}::${focusKind ?? ''}`
    if (focusKeyRef.current === focusKey) return
    focusKeyRef.current = focusKey
    if (!initializedRef.current || items.length === 0) return
    const index = findDiffFocusIndex(items, focusPath, focusKind)
    if (index < 0) return
    // findDiffFocusIndex falls back to 0 when nothing matches. In the working
    // tree that is harmless — the list IS the status — but a commit step holds
    // only its own files, so a Git-panel row for a file this step never touched
    // would silently move the cursor to an unrelated one. Stay put instead.
    if (branchSteps && focusPath && items[index]?.path !== focusPath) return
    hunkIndexRef.current = 0
    pendingEdgeRef.current = null
    currentPathKeyRef.current = keyFor(items[index])
    currentPathRef.current = items[index]?.path ?? null
    setCurrentIndex(index)
  }, [focusPath, focusKind, items])

  // One token for every read in flight, target change and live re-read alike:
  // whoever started last is the only one allowed to land.
  const loadSeqRef = useRef(0)
  // A SECOND, monotonic token, taken only by the live re-reads below. They
  // cannot take `loadSeqRef`'s: incrementing it would cancel the target
  // effect's own in-flight read, and merely READING it (which is what the live
  // effect did until this was reviewed) hands two concurrent live re-reads the
  // same number, so the older one passes the check and lands last — the stale
  // text this whole effect exists to remove. Two counters, both checked on
  // resolve: the load token says "no file switch since", the live token says
  // "no newer live re-read since". Not extractable as a pure function without
  // lifting the whole read out of the component, so it is asserted here in
  // words rather than in a test.
  const liveSeqRef = useRef(0)
  // The item the live re-read should read, without making that effect depend on
  // the item (it must fire on the tree moving, and on nothing else).
  const currentItemRef = useRef<DiffFileItem | null>(null)
  currentItemRef.current = currentItem

  // Which repository the content on screen came from. A step within one repo
  // may keep the previous diff on screen; a change of repository may not.
  const contentRepoRef = useRef(repoRoot)

  useEffect(() => {
    if (!currentItem) {
      loadSeqRef.current += 1
      setContent({ state: 'loading' })
      monacoStepsRef.current = []
      setDifferenceCount(0)
      return
    }
    loadSeqRef.current += 1
    const token = loadSeqRef.current
    const sameRepo = contentRepoRef.current === repoRoot
    contentRepoRef.current = repoRoot
    const next = contentAcrossTargetChange(contentRef.current, sameRepo)
    if (next.state !== 'ready') {
      // Only when the editor is going away anyway: leaving these behind while
      // the previous file is still drawn is what keeps the stepper and the
      // counter describing what is actually on screen.
      monacoStepsRef.current = []
      setDifferenceCount(0)
    }
    setContent(next)
    hunkIndexRef.current = 0
    void loadDiffContent(repoRoot, currentItem).then((next) => {
      if (loadSeqRef.current === token) setContent(next)
    })
  }, [
    repoRoot,
    currentItem?.path,
    currentItem?.kind,
    // Stepping to another commit leaves path and kind identical while both sides
    // move; without these the pane would keep showing the previous step's diff.
    (currentItem as BranchDiffItem | null)?.originalRev,
    (currentItem as BranchDiffItem | null)?.modifiedRev,
  ])

  // Live content. The file LIST re-read when the working tree moved; the open
  // file's content never did, so a save behind the window (an agent's edit, a
  // commit, a stash) left yesterday's text on screen until the person clicked
  // another row and back. This re-reads the same two sides on the status hook's
  // own debounced tick, WITHOUT going through the loading state: the editor
  // stays mounted, and the diff-update callback re-reveals the hunk the cursor
  // was on, so the position survives as well as it can.
  const appliedRevisionRef = useRef<number | null>(null)
  useEffect(() => {
    if (appliedRevisionRef.current === treeRevision) return
    const previous = appliedRevisionRef.current
    appliedRevisionRef.current = treeRevision
    // Nothing to re-read until this viewer has seen a completed read: 0 is
    // "the hook has not answered yet", and the first real number is the read
    // the target effect above is already loading from.
    if (previous === null || previous === 0) return
    const item = currentItemRef.current
    if (!item) return
    const loadToken = loadSeqRef.current
    liveSeqRef.current += 1
    const liveToken = liveSeqRef.current
    void loadDiffContent(repoRoot, item).then((next) => {
      // A file switch during the read supersedes it: its own load is authoritative.
      if (loadSeqRef.current !== loadToken) return
      // And a LATER live re-read supersedes an earlier one: two ticks of the
      // status hook close together read the same two sides twice, and without
      // this the slower (older) read is free to land second.
      if (liveSeqRef.current !== liveToken) return
      setContent((previous) => (sameDiffContent(previous, next) ? previous : next))
    })
  }, [treeRevision, repoRoot])

  // The steppers, reachable from the mount callback above the definitions they
  // point at. Monaco keybindings are registered ONCE, at mount, and a keybinding
  // that closed over the first render's `navigate` would step from the file that
  // was open when the window opened.
  const navigateRef = useRef<(direction: 'next' | 'prev') => void>(() => {})
  const navigateWholeFileRef = useRef<(direction: 'next' | 'prev') => void>(() => {})

  const revealHunk = useCallback((index: number) => {
    const editor = diffEditorRef.current
    const steps = diffSteps()
    if (!editor || steps.length === 0) return
    const clamped = Math.min(Math.max(index, 0), steps.length - 1)
    const step = steps[clamped]
    hunkIndexRef.current = clamped
    // A pure deletion has no line on the modified side; reveal the original
    // there, otherwise the modified one (the diff editor syncs scroll).
    if (step.side === 'original') {
      editor.getOriginalEditor().revealLineInCenter(step.line)
      return
    }
    const modified = editor.getModifiedEditor()
    modified.revealLineInCenter(step.line)
    modified.setPosition({ lineNumber: step.line, column: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDiffMount = useCallback<DiffOnMount>(
    (editor, monaco) => {
      diffEditorRef.current = editor
      // The one editor drawn in BOTH views: side-by-side shows it beside the
      // original, unified relays both sides into it. Every hunk box goes here,
      // so the gutter does not half-vanish with the layout toggle.
      const modified = editor.getModifiedEditor() as unknown as GlyphMarginHost
      setGutterHost({
        editor: modified,
        lane: monaco.editor.GlyphMarginLane?.Center ?? GLYPH_MARGIN_LANE_CENTER,
      })
      // The models the wrapper created for this mount; it keeps them (see the
      // props), so they are released here once the widget has let go of them.
      const model = editor.getModel()
      editor.onDidDispose(() => {
        // Let go of the gutter first: its widgets belong to an editor that no
        // longer exists, and a later effect must not try to remove them from it.
        // Guarded on identity — a file switch mounts the next editor around the
        // same time this fires, and clearing unconditionally would blank a
        // gutter that has already been handed its new home.
        setGutterHost((current) => (current && current.editor === modified ? null : current))
        window.setTimeout(() => {
          model?.original.dispose()
          model?.modified.dispose()
        }, 0)
      })
      // A window opened moments ago may have measured a fallback face; see
      // `remeasureWhenMonoFontLoads` for why the caret drifts until it does.
      editor.onDidDispose(remeasureWhenMonoFontLoads(() => monaco.editor.remeasureFonts()))
      // The steppers, registered ON THE EDITOR as well as on the window.
      //
      // Monaco has the keyboard whenever the diff is focused, and the window
      // listener deliberately keeps out of it (`takesNavigationKey`), so
      // without these F7 and ⌘↑ / ⌘↓ would simply stop working the moment a
      // person clicked into the text they are stepping through. `addCommand`
      // is how a keybinding is added to the editor that owns them, and it
      // supersedes nothing Monaco itself binds: F7 is unbound in a read-only
      // diff, and ⌘↑ / ⌘↓ are only its "cursor to top / bottom", which the
      // ⌘Home / ⌘End of the same editor still gives.
      editor.addCommand(monaco.KeyCode.F7, () => navigateRef.current('next'))
      editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => navigateRef.current('prev'))
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow, () => navigateWholeFileRef.current('next'))
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow, () => navigateWholeFileRef.current('prev'))
      editor.onDidUpdateDiff(() => {
        const changes = editor.getLineChanges() ?? []
        monacoStepsRef.current = changes.map(monacoStep)
        // The toolbar's counter reads this; the ref alone cannot re-render it.
        setDifferenceCount(changes.length)
        const pending = pendingEdgeRef.current
        if (pending) {
          pendingEdgeRef.current = null
          revealHunk(resolveEdgeHunkIndex(pending, diffSteps().length))
        } else {
          revealHunk(hunkIndexRef.current)
        }
      })
    },
    [revealHunk],
  )

  const navigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (items.length === 0 || currentIndex < 0) return
      const move = nextDiffPosition(
        { fileIndex: currentIndex, hunkIndex: hunkIndexRef.current },
        direction,
        diffSteps().length,
        items.length,
      )
      if (move.type === 'none') return
      if (move.type === 'hunk') {
        revealHunk(move.hunkIndex)
        return
      }
      // Cross into another file; the edge resolves once its diff recomputes.
      pendingEdgeRef.current = move.edge
      hunkIndexRef.current = 0
      currentPathKeyRef.current = keyFor(items[move.fileIndex])
      currentPathRef.current = items[move.fileIndex]?.path ?? null
      setCurrentIndex(move.fileIndex)
    },
    [items, currentIndex, revealHunk],
  )

  // Land on a file by index — the toolbar's `‹ 2/27 files ›` stepper and
  // ⌘↑ / ⌘↓. It goes through the SAME pendingEdgeRef the hunk walk uses when it
  // crosses a boundary, so a file with no hunks at all (binary, mode-only) is
  // arrived at and shown rather than stepped over.
  const goToFileIndex = useCallback(
    (fileIndex: number) => {
      if (fileIndex < 0 || fileIndex >= items.length || fileIndex === currentIndex) return
      pendingEdgeRef.current = 'first'
      hunkIndexRef.current = 0
      currentPathKeyRef.current = keyFor(items[fileIndex])
      currentPathRef.current = items[fileIndex]?.path ?? null
      setCurrentIndex(fileIndex)
    },
    [items, currentIndex],
  )

  const navigateWholeFile = useCallback(
    (direction: 'next' | 'prev') => {
      const move = navigateFile(currentIndex, direction, items.length)
      if (move.type !== 'file') return
      goToFileIndex(move.fileIndex)
    },
    [currentIndex, items.length, goToFileIndex],
  )

  navigateRef.current = navigate
  navigateWholeFileRef.current = navigateWholeFile

  // The viewer is read-only, so arrows always navigate hunks — except with the
  // platform's command modifier held, which steps a whole FILE (⌘↑ / ⌘↓ on
  // macOS, Ctrl elsewhere). The modifier is tested first: a plain ArrowDown
  // must never also fire while ⌘ is down, or one press would move twice.
  // F7 / Shift+F7 step hunks the same way the in-pane Monaco viewer does.
  // Returns whether
  // the key was taken.
  const handleNavigationKey = useCallback(
    (event: {
      key: string
      shiftKey: boolean
      metaKey?: boolean
      ctrlKey?: boolean
      preventDefault: () => void
    }): boolean => {
      const fileStep = isMac ? event.metaKey === true : event.ctrlKey === true
      if (fileStep && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        navigateWholeFile(event.key === 'ArrowDown' ? 'next' : 'prev')
        return true
      }
      if (fileStep) return false
      if (event.key === 'ArrowDown' || (event.key === 'F7' && !event.shiftKey)) {
        event.preventDefault()
        navigate('next')
        return true
      }
      if (event.key === 'ArrowUp' || (event.key === 'F7' && event.shiftKey)) {
        event.preventDefault()
        navigate('prev')
        return true
      }
      return false
    },
    [navigate, navigateWholeFile, isMac],
  )

  // The window owns its whole keyboard, so the keys are window-wide there and
  // Escape closes it. In the pane the same keys are scoped to the viewer's own
  // focus (a window-wide ArrowDown would hijack every list in the app). Neither
  // scope changed in T4; what changed is that the band now contains controls
  // that own the arrow keys themselves, so `takesNavigationKey` keeps a hunk
  // step from firing on top of a view change or a menu walk — and MONACO is one
  // of those controls. With the diff focused the steppers come from the
  // editor's own keybindings (`handleDiffMount`), never from here, so one press
  // is one move.
  useEffect(() => {
    if (variant !== 'window') return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (takesNavigationKey(target) && handleNavigationKey(event)) return
      // Escape inside the gear menu closes the MENU (the popover's own handler);
      // it must not also take the window down with it.
      if (event.key === 'Escape' && !target?.closest?.('[role="menu"]')) void window.api.windowClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleNavigationKey, variant])

  const positionLabel =
    items.length > 0 && currentIndex >= 0 ? `File ${currentIndex + 1} of ${items.length}` : 'No changes'

  const openInWindow = useCallback(() => {
    const target = currentItem ?? items[0]
    // The aux window shows the WORKING TREE; a branch step has no counterpart
    // there, so it opens on the unstaged view of the same file rather than
    // carrying a scope the window cannot honour.
    const scope = target?.kind === 'branch' ? 'unstaged' : target?.kind
    // Asking for the window IS the preference: from here on a Git row opens
    // one, until the window's "Show in the app" says otherwise.
    useWorkspaceStore.getState().setDiffOpensInWindow(true)
    void openDiffWindow({
      ...(workspaceId ? { workspaceId } : {}),
      repoRoot,
      focusPath: target?.path ?? focusPath ?? '',
      scope: scope ?? focusKind ?? 'unstaged',
      // The list the pane is filtered to goes with it; the window opens on the
      // same seven files, not on the whole repository.
      ...(filterId ? { changelistId: filterId } : {}),
    })
  }, [currentItem, filterId, focusKind, focusPath, items, repoRoot, workspaceId])

  // The window's half of the flip. The preference is NOT written here: this
  // window's store was hydrated when it opened, and writing the settings
  // envelope from it would push a snapshot of that moment over whatever the
  // workspace window has changed since. The workspace window flips it as it
  // opens the tab (WorkspaceManager), exactly as docking a file back does.
  // ── The failure band ────────────────────────────────────────────────────
  // ONE message, and it is the newest one. There were three states here —
  // the hand-off's, the file box's and the hunk read's — collapsed at the
  // render with `??`, which is a PRIORITY, not a recency: a "No open workspace"
  // from ten minutes ago outranked git's reason for refusing the click a person
  // had just made, and nothing cleared any of them when the file changed, so a
  // complaint about one file was still on screen over another.
  const [bandError, setBandError] = useState<string | null>(null)
  const showInApp = useCallback(() => {
    if (!workspaceId) return
    const target = currentItem ?? items[0]
    const kind = target?.kind === 'branch' ? 'unstaged' : target?.kind
    void (async () => {
      setBandError(null)
      const result = await window.api.dockDiffToWorkspace({
        workspaceId,
        repoRoot,
        focusPath: target?.path ?? focusPath ?? null,
        focusKind: kind ?? focusKind ?? null,
        // The filter the person is looking at — the strip's choice, not the
        // one the window opened on — so the pane tab shows the same list.
        changelistId: filterId,
      })
      // Closed only once a window has SAID it took the diff. "On its way" was
      // not enough: the hand-off is a broadcast that every workspace window is
      // free to ignore (none of them holds this workspace, or none is open at
      // all), and closing on the strength of that left the person with neither
      // the window nor the tab. On a refusal the window stays up and says why.
      if (!result?.accepted) {
        setBandError('No open workspace to show this in')
        return
      }
      await window.api.windowClose()
    })()
  }, [currentItem, filterId, focusKind, focusPath, items, repoRoot, workspaceId])

  // ── How the diff is drawn ───────────────────────────────────────────────
  // `diffView` is the persisted app setting (settingsSlice); the other three
  // are this window's own session state. All four reach Monaco through
  // `liveDiffEditorOptions`, so changing any of them is an `updateOptions`
  // call and never a remount.
  // Narrowed on read: the persisted envelope is a JSON blob a previous version
  // (or a hand edit) could have left anything in, and an unrecognised value
  // would leave the radiogroup with no checked segment at all.
  const diffView = useWorkspaceStore((state) => (state.diffView === 'unified' ? 'unified' : 'side-by-side'))
  const [sessionPrefs, setSessionPrefs] = useState(DEFAULT_DIFF_EDITOR_PREFS)
  const editorPrefs = useMemo<DiffEditorPrefs>(() => ({ diffView, ...sessionPrefs }), [diffView, sessionPrefs])
  const editorOptions = useMemo(() => diffEditorOptions(editorPrefs, MONO_FONT_STACK), [editorPrefs])

  useEffect(() => {
    // No editor yet is not a missed update: the construction options above
    // carry the same values, so a mount that happens later starts correct.
    // `onDidUpdateDiff` fires after this and re-reveals the hunk the cursor was
    // on, so toggling the view keeps the person's place.
    const editor = diffEditorRef.current
    if (!editor) return
    editor.updateOptions(liveDiffEditorOptions(editorPrefs))
    // Switching to unified relays both sides into one editor. Monaco keeps the
    // scroll offset, which is not the same thing as keeping the HUNK — so the
    // cursor is re-revealed rather than left to whatever the relayout produced.
    revealHunk(hunkIndexRef.current)
  }, [editorPrefs, revealHunk])

  const setDiffView = useCallback((next: DiffViewMode) => {
    // See auxSettingsWrite: an aux window may only write a setting after
    // re-reading what the workspace window has persisted since it opened.
    writeAuxWindowSetting(() => useWorkspaceStore.getState().setDiffView(next))
  }, [])

  // ── The file include box ────────────────────────────────────────────────
  // Whole-file stage / unstage of the file on screen, through the same
  // `git:stage` / `git:unstage` IPC the Git panel's rows use.
  const gitEntry = getGitEntry(status, currentItem?.path ?? null)
  const observedInclude = useMemo(
    () => includeBoxState(gitEntry ? { staged: gitEntry.staged, unstaged: gitEntry.unstaged } : null),
    [gitEntry?.staged, gitEntry?.unstaged],
  )
  // `git status` is debounced by a second under the watcher, so between the
  // click and the next read the box would still show the old state — and a
  // second click would compute the OPPOSITE action from it and undo the first.
  // The optimistic value is what the box shows and what `includeAction` reads
  // until git agrees; the busy latch refuses a second write while one is in
  // flight. Keyed on the PATH, not the (kind, path) key, because including a
  // file is exactly what moves it between the two kinds.
  const [includeOverride, setIncludeOverride] = useState<{ path: string; state: IncludeBoxState } | null>(null)
  const includeBusyRef = useRef(false)
  // What the file's include box means UNDER A FILTER: this list's hunks, and
  // their include state. Filled in below, after the hunk read that answers it —
  // through a ref rather than by moving the read up here, because the callback
  // must not be rebuilt on every watcher tick. Empty (`list: null`) whenever
  // there is no filter, and then the box is the whole-file box it always was.
  const listStageRef = useRef<{ list: string | null; hunks: GitHunkView[] }>({ list: null, hunks: [] })

  const fileInclude =
    includeOverride && includeOverride.path === currentItem?.path ? includeOverride.state : observedInclude

  useEffect(() => {
    if (!includeOverride) return
    if (includeOverride.path !== currentItem?.path) {
      setIncludeOverride(null)
      return
    }
    if (
      observedInclude.checked === includeOverride.state.checked &&
      observedInclude.indeterminate === includeOverride.state.indeterminate
    ) {
      setIncludeOverride(null)
    }
  }, [includeOverride, observedInclude, currentItem?.path])

  const toggleInclude = useCallback(() => {
    const item = currentItem
    if (!item || !isIncludable(item) || includeBusyRef.current) return
    const owned = listStageRef.current
    const action = includeAction(fileInclude)
    includeBusyRef.current = true
    setIncludeOverride({
      path: item.path,
      state: { checked: action === 'stage', indeterminate: false },
    })
    void (async () => {
      try {
        // UNDER A FILTER the box is not "this file": it is "my list's part of
        // this file". Staging the whole file would quietly stage another
        // agent's hunks — the one thing a per-agent view exists to prevent — so
        // the box loops the list's own hunks instead. Order does not matter:
        // main locates a hunk by the fingerprint of its body, not by an index
        // that staging the hunk above it would have moved.
        const result = owned.list
          ? await stageOwnedHunks({
              repoRoot,
              filePath: item.path,
              hunks: owned.hunks,
              action,
            })
          : action === 'stage'
            ? await window.api.stageGitPaths(repoRoot, [item.relativePath])
            : await window.api.unstageGitPaths(repoRoot, [item.relativePath])
        if (!result.ok) {
          // Let the real state win rather than leaving a box that lies.
          setIncludeOverride(null)
          setBandError(result.message ?? result.stderr ?? 'Could not change what is included.')
        } else {
          setBandError(null)
        }
        await refreshGitStatus()
      } catch (error) {
        setBandError(error instanceof Error ? error.message : 'Could not change what is included.')
      } finally {
        // The refresh above awaits a completed `git status`, so by here the
        // truth is on screen: drop the optimistic value unconditionally rather
        // than leaving a box that disagrees with the index for good if the
        // write landed somewhere we did not predict.
        setIncludeOverride(null)
        includeBusyRef.current = false
      }
    })()
  }, [currentItem, fileInclude, refreshGitStatus, repoRoot])

  // ── The hunk include boxes ──────────────────────────────────────────────
  // One box per hunk of the diff on screen, in Monaco's glyph margin, and the
  // file's own "N differences, M included" count. Both come from ONE read in
  // main, so the boxes and the sentence above them can never be describing two
  // different moments (useFileHunks / src/main/git-hunks.ts).
  const fileHunks = useFileHunks({
    repoRoot,
    item: currentItem,
    treeRevision,
    refreshGitStatus,
  })
  // Whose hunks these are, for the hunks the filtered list does NOT own. The
  // model answers per hunk (`hunkOwnerId` — most new-side lines covered, the
  // file's home list for the remainder), so a file that three agents touched
  // reads as three names down one gutter. Empty whenever there is no filter,
  // which is what leaves the ordinary gutter exactly as T7 drew it.
  const foreignHunkOwners = useMemo(() => {
    if (!filterList || !currentItem || currentItem.kind === 'branch') return undefined
    const names = new Map(changelists.map((list) => [list.id, list.name]))
    const owners: Record<string, string> = {}
    for (const hunk of fileHunks.hunks) {
      const ownerId = hunkOwnerId(changelists, currentItem.relativePath, hunk)
      if (ownerId === filterList.id) continue
      owners[hunkKey(hunk)] = names.get(ownerId) ?? ownerId
    }
    return Object.keys(owners).length > 0 ? owners : undefined
  }, [filterList, changelists, fileHunks.hunks, currentItem?.kind, currentItem?.relativePath])

  // The hunks the FILTERED list owns in the file on screen — what its include
  // box acts on, and what its tri-state reads.
  const listHunks = useMemo(() => {
    if (!filterList || !currentItem || currentItem.kind === 'branch') return []
    return fileHunks.hunks.filter((hunk) => hunkOwnerId(changelists, currentItem.relativePath, hunk) === filterList.id)
  }, [filterList, changelists, fileHunks.hunks, currentItem?.kind, currentItem?.relativePath])
  listStageRef.current = { list: filterList && listHunks.length > 0 ? filterList.id : null, hunks: listHunks }

  // The include box under a filter is the LIST's tri-state, not the file's: all
  // of my hunks in, some in, none in. A pending click still wins over it — the
  // optimistic value is the same one the unfiltered box uses, and it is dropped
  // the moment git has answered either way.
  const listInclude = useMemo<IncludeBoxState | null>(() => {
    if (!filterList || listHunks.length === 0) return null
    const included = listHunks.filter((hunk) => hunk.included).length
    if (included === 0) return { checked: false, indeterminate: false }
    if (included === listHunks.length) return { checked: true, indeterminate: false }
    return { checked: false, indeterminate: true }
  }, [filterList, listHunks])
  const boxInclude =
    includeOverride && includeOverride.path === currentItem?.path ? fileInclude : (listInclude ?? fileInclude)

  const gutterBoxes = useMemo(
    () =>
      hunkBoxes({
        hunks: fileHunks.hunks,
        key: hunkFileKey(currentItem),
        override: fileHunks.override,
        relativePath: currentItem?.relativePath ?? '',
        ...(foreignHunkOwners ? { foreignOwners: foreignHunkOwners } : {}),
      }),
    [
      fileHunks.hunks,
      fileHunks.override,
      foreignHunkOwners,
      currentItem?.kind,
      currentItem?.path,
      currentItem?.relativePath,
    ],
  )

  // The stepper's stops, from the same hunks the boxes and the counter come
  // from — so "2 differences" and two presses of ↓ are the same two. Null when
  // git has not counted this file (a branch step, a binary, a read still in
  // flight), and Monaco's changes stand in.
  gitStepsRef.current = fileHunks.summary
    ? fileHunks.hunks.map((hunk) => ({ line: hunkGutterLine(hunk), side: 'modified' as const }))
    : null

  // The band belongs to the FILE on screen. A failure about the last one is not
  // a fact about this one, and leaving it up made the window look broken on a
  // file that was perfectly fine. Declared before the mirror below so that a
  // step which both changes the file and lands a read failure ends on the
  // failure rather than on the clear.
  useEffect(() => {
    setBandError(null)
  }, [currentItem?.path])

  // The hunk read's own failure, folded into the one band. It clears itself
  // when a later read succeeds — but only if the band is still showing what it
  // put there, or a hand-off refusal since would vanish with it.
  const hunkErrorRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = hunkErrorRef.current
    hunkErrorRef.current = fileHunks.error
    if (fileHunks.error) {
      setBandError(fileHunks.error)
      return
    }
    setBandError((current) => (current !== null && current === previous ? null : current))
  }, [fileHunks.error])

  // ── Open in editor ──────────────────────────────────────────────────────
  // The pane routes through `openFileSurface`, which honours the person's
  // "where do files open" preference. The WINDOW cannot: it has no pane to add
  // a tab to and writing that preference from here is the hazard T3 named, so
  // it opens the external editor window — the aux window's own sibling.
  const openInEditor = useCallback(() => {
    const item = currentItem
    if (!item) return
    const name = item.relativePath.split('/').filter(Boolean).pop() ?? item.relativePath
    if (variant === 'window') {
      void openExternalFileWindow({ workspaceId: workspaceId ?? '', path: item.path, name })
      return
    }
    if (!workspaceId) return
    openFileSurface({ workspaceId, path: item.path, name })
  }, [currentItem, variant, workspaceId])

  // ── The counter ─────────────────────────────────────────────────────────
  // Monaco's count, mirrored from the ref it writes into a callback so the
  // sentence has something to re-render on. It is only the FALLBACK total:
  // `differenceCounterLabel` prefers git's, which is also what the stepper
  // walks (`gitStepsRef`), so the words and the arrows count the same things.
  const [differenceCount, setDifferenceCount] = useState(0)
  const counterLabel = differenceCounterLabel({
    item: currentItem,
    differenceCount,
    fileInclude,
    hunkSummary: fileHunks.summary,
  })

  const header = headerStripModel(currentItem)

  // The select IS the name: one control and one fact rather than a label beside
  // a control that could disagree with it. The file count is NOT repeated here
  // — the toolbar's stepper already reads "1/7 files" over the same list, and in
  // the pane's width a second count pushed the right half of the strip under
  // the left one.
  const filterOptions = useMemo(
    () => [
      { value: ALL_CHANGES, label: 'All changes' },
      ...changelists.map((list) => ({ value: list.id, label: list.name })),
    ],
    [changelists],
  )

  // The window's name, editor-style: `Commit: <file>`. ONE string, used by
  // both the OS title (the window switcher, which T3 set) and the title bar the
  // person is looking at — they cannot drift apart if there is only one of
  // them. The pane host never touches the document title: it does not own the
  // window.
  const relativePath = currentItem?.relativePath ?? null
  const fileName = relativePath ? (relativePath.split('/').filter(Boolean).pop() ?? relativePath) : null
  const windowTitle = fileName ? `Commit: ${fileName}` : 'Diff'
  useEffect(() => {
    if (variant !== 'window') return
    document.title = windowTitle
  }, [windowTitle, variant])

  // The window's title bar: the traffic-light inset, the drag region, and the
  // name — nothing else. Every ACTION lives in the toolbar below it, so the two
  // hosts differ only by whether this row is there at all.
  const titleBarClass = `app-drag relative flex ${TITLE_BAR_HEIGHT} shrink-0 items-center justify-center border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-2 ${
    isMac ? TRAFFIC_LIGHT_INSET : ''
  }`

  const noFiles = items.length === 0 || currentIndex < 0
  // The filter is on, the lists have been read, and the list is empty — the
  // agent's work has all been committed. That is an ANSWER, not an empty
  // repository, so it says whose list it is and offers the one click out.
  const filteredEmpty =
    Boolean(filterList) && items.length === 0 && repoState === 'ready' && (!branchSteps || branchShowsWorktree)

  return (
    <div
      className={
        variant === 'window'
          ? 'flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]'
          : `flex h-full w-full flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)] ${FOCUS_RING_INSET_CLASS}`
      }
      tabIndex={variant === 'pane' ? 0 : undefined}
      onKeyDown={
        variant === 'pane'
          ? (event) => {
              if (!takesNavigationKey(event.target as HTMLElement | null)) return
              handleNavigationKey(event)
            }
          : undefined
      }
    >
      {branchSteps ? (
        <BranchStepStrip entries={stripEntries} selection={steps.selection} onSelect={steps.select} note={stepNote} />
      ) : null}

      {variant === 'window' ? (
        <div className={titleBarClass}>
          <span className="truncate text-body font-semibold text-[color:var(--text-strong)]">{windowTitle}</span>
        </div>
      ) : null}

      {/* The band belongs to the diff beneath it and would be meaningless
          without it, which is what lets it hold more than the pane-chrome
          ceiling of five (design-system/components/toolbar). Grouped, not
          enumerated: the hunk arrows, the file's editor, the file stepper and
          the collapse toggle are four things about WHAT you are reading; the
          counter, the layout toggle and the gear are about HOW. */}
      <Toolbar ariaLabel="Diff">
        <Tooltip content={`Previous change (${isMac ? '⇧F7' : 'Shift+F7'})`} placement="bottom">
          <ToolbarButton ariaLabel="Previous change" disabled={noFiles} onClick={() => navigate('prev')}>
            <PreviousDifferenceGlyph />
          </ToolbarButton>
        </Tooltip>
        <Tooltip content="Next change (F7)" placement="bottom">
          <ToolbarButton ariaLabel="Next change" disabled={noFiles} onClick={() => navigate('next')}>
            <NextDifferenceGlyph />
          </ToolbarButton>
        </Tooltip>

        <ToolbarDivider />

        <Tooltip content="Open in editor" placement="bottom">
          <ToolbarButton
            ariaLabel="Open in editor"
            disabled={!currentItem || (variant === 'pane' && !workspaceId)}
            onClick={openInEditor}
          >
            <OpenInEditorGlyph />
          </ToolbarButton>
        </Tooltip>

        <ToolbarDivider />

        {/* The FILE stepper, as opposed to the change stepper on the left.
            `pager --inline`: the drawn "2/27 files" and the announced sentence
            are one element, and the chevrons disable at the ends rather than
            disappearing. */}
        <Pager
          inline
          inlineNoun={items.length === 1 ? 'file' : 'files'}
          // "0/0 files" when there are none, not "1/1": the band keeps its
          // width either way, and a stepper claiming one file over an empty
          // list is the one thing worse than an empty stepper.
          page={noFiles ? 0 : currentIndex + 1}
          pageCount={items.length}
          rangeLabel={positionLabel}
          // The shortcut goes on the CHEVRONS. `rangeLabel` is a live region,
          // so a hint folded into it was read out again on every step.
          stepHint={isMac ? '⌘↑ / ⌘↓' : 'Ctrl+↑ / Ctrl+↓'}
          ariaLabel="Changed files in this diff"
          onPageChange={(page) => goToFileIndex(page - 1)}
        />

        <ToolbarDivider />

        {/* A toggle with no `aria-pressed` to spend: the NAME changes with the
            state instead, which is what a screen reader reads out either way
            and what the tooltip already had to say. */}
        <Tooltip
          content={sessionPrefs.hideUnchanged ? 'Show unchanged regions' : 'Collapse unchanged regions'}
          placement="bottom"
        >
          <ToolbarButton
            ariaLabel={sessionPrefs.hideUnchanged ? 'Show unchanged regions' : 'Collapse unchanged regions'}
            onClick={() => setSessionPrefs((prefs) => ({ ...prefs, hideUnchanged: !prefs.hideUnchanged }))}
          >
            <CollapseAllGlyph />
          </ToolbarButton>
        </Tooltip>

        <ToolbarSpacer />

        {/* Not a live region: the file stepper beside it already announces every
            move, and two polite regions in one 30px band means every file change
            is read out twice. */}
        {currentItem && content.state === 'ready' ? (
          <span className="shrink-0 whitespace-nowrap px-1 text-meta tabular-nums text-[color:var(--text-muted)]">
            {counterLabel}
          </span>
        ) : null}

        <SegmentedControl<DiffViewMode>
          iconOnly
          ariaLabel="Diff view"
          value={diffView}
          onChange={setDiffView}
          items={[
            {
              value: 'side-by-side',
              label: 'Side by side',
              icon: <SideBySideGlyph />,
              tooltip: 'Side by side',
            },
            { value: 'unified', label: 'Unified', icon: <UnifiedGlyph />, tooltip: 'Unified' },
          ]}
          className="mx-1 shrink-0"
        />

        <DiffSettingsMenu
          prefs={editorPrefs}
          onChange={(patch) => setSessionPrefs((prefs) => ({ ...prefs, ...patch }))}
        />

        {/* The sticky preference's two writers, absorbed from T3's band. */}
        {variant === 'pane' ? <OpenInWindowButton onClick={openInWindow} /> : null}
        {variant === 'window' && workspaceId ? <ShowInAppButton onClick={showInApp} /> : null}
      </Toolbar>

      {/* THE FIRST CONTENT ROW, not a second chrome band. It names the two
          things being compared and carries this file's include box; hide the
          diff and it has nothing to say, which is the test. It scrolls with
          nothing — the code under it does. Left is what the file is compared
          AGAINST, right is what you are looking at, and both come from the
          revisions `loadDiffContent` actually read (diffToolbarModel). */}
      <div
        className={`flex shrink-0 items-stretch border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] text-meta ${
          // A control is 30px and this row is 28px, so the row grows — but only
          // where a filter put a control in it. An unfiltered diff keeps the
          // 28px strip T4 drew, to the pixel.
          filtering ? 'min-h-8' : 'h-7'
        }`}
      >
        {/* Both halves clip: each is `flex-1 min-w-0`, and in a narrow pane the
            left one's fixed-width children (the select, the lock, the base
            revision) used to spill under the right one's text instead of being
            cut at the divider. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-3">
          {/* WHOSE changes you are looking at, and the one click back to all of
              them. Only under a filter: an ordinary diff has nothing to choose
              between, and a select offering one option is a control that does
              nothing. */}
          {filtering ? (
            <>
              <Select
                ariaLabel="Show one changelist"
                className="shrink-0"
                triggerMinWidthClassName="min-w-0"
                value={filterList ? filterList.id : ALL_CHANGES}
                items={filterOptions}
                onChange={(next) =>
                  setChosenFilter({
                    from: changelistId ?? null,
                    id: next === ALL_CHANGES ? null : next,
                  })
                }
              />
              {filterMissing ? (
                // The list this window was opened on has been deleted, or its
                // agent exited and reconcile cleared it. Say so and show
                // everything — a viewer that went blank because its filter
                // outlived its list is the failure this sentence exists for.
                <MicroChip className="shrink-0">That changelist is gone</MicroChip>
              ) : null}
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[color:var(--border-subtle)]" />
            </>
          ) : null}
          {/* The padlock: this side is not yours to edit. Reused from
              FileTypeGlyph rather than redrawn (glyphs/component.md). */}
          <FileTypeGlyph kind="lock" className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
          {header ? (
            <span
              className={
                header.base.mono
                  ? 'shrink-0 font-mono text-[color:var(--text-default)]'
                  : 'shrink-0 text-[color:var(--text-default)]'
              }
            >
              {header.base.text}
            </span>
          ) : null}
          <span className="truncate text-[color:var(--text-muted)]" title={relativePath ?? undefined}>
            {relativePath ?? 'Git Diff'}
          </span>
          {currentItem ? (
            <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
              {STATUS_LABEL[currentItem.status]}
              {currentItem.kind === 'branch' &&
              (currentItem as BranchDiffItem).additions + (currentItem as BranchDiffItem).deletions > 0 ? (
                /* One channel for the whole diff surface: +N/−N read --diff-*,
                   the same tokens the body's ink and the gutter use, not the
                   status tones they used to borrow. */
                <span className="ml-1 font-mono tabular-nums">
                  <span className="text-[color:var(--diff-added)]">+{(currentItem as BranchDiffItem).additions}</span>
                  <span className="ml-1 text-[color:var(--diff-removed)]">
                    −{(currentItem as BranchDiffItem).deletions}
                  </span>
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden border-l border-[color:var(--border-subtle)] px-3">
          {header?.includable && currentItem ? (
            <Checkbox
              checked={boxInclude.checked}
              indeterminate={boxInclude.indeterminate}
              onChange={toggleInclude}
              ariaLabel={
                listStageRef.current.list && filterList
                  ? `Include ${filterList.name}\u2019s changes to ${currentItem.relativePath} in the commit`
                  : `Include ${currentItem.relativePath} in the commit`
              }
            />
          ) : null}
          {header ? (
            <span
              className={
                header.current.mono
                  ? 'truncate font-mono text-[color:var(--text-default)]'
                  : 'truncate text-[color:var(--text-default)]'
              }
            >
              {header.current.text}
            </span>
          ) : null}
        </div>
      </div>

      {/* One band for every failure this window can report — the whole file's
          include, a single hunk's, and a hand-off back to the app that no
          window took. They are the same sentence to a person ("that did not
          happen"), and git's own words are what the include failures show. One
          STATE as well as one band: whichever failed last is what is shown, and
          changing file clears it. */}
      {bandError ? (
        <InlineNotice tone="error" className="mx-3 mt-2 shrink-0">
          {bandError}
        </InlineNotice>
      ) : null}

      <div
        className="relative min-h-0 flex-1"
        // The panel the step strip's tabs control. Only when a strip is there to
        // control it: a tabpanel with no tablist is a lie to a screen reader.
        id={branchSteps ? BRANCH_STEP_PANEL_ID : undefined}
        role={branchSteps ? 'tabpanel' : undefined}
      >
        {filterPending ? (
          // The lists are one IPC read behind the status snapshot. "No changed
          // files" during that beat would be a claim about the repository made
          // before anyone asked it anything.
          <CenteredMessage>Loading changes\u2026</CenteredMessage>
        ) : filteredEmpty ? (
          <EmptyState
            title={`${filterList?.name ?? 'This changelist'} has nothing changed here.`}
            body="Everything it owned has been committed, moved to another list, or discarded."
            action={
              <OutlineButton size="sm" onClick={showAllChanges}>
                Show all changes
              </OutlineButton>
            }
          />
        ) : (
          <DiffBody
            content={content}
            repoState={repoState}
            currentItem={currentItem}
            onMount={handleDiffMount}
            monacoTheme={monacoTheme}
            options={editorOptions}
            stepLoading={branchSteps && steps.loading}
          />
        )}
        {/* Renders nothing of its own — only portals into the widget nodes it
            hangs in Monaco's glyph margin — so where it sits in the tree is
            immaterial, and it sits beside the editor it draws on. */}
        {content.state === 'ready' ? (
          <HunkGutter
            editor={gutterHost?.editor ?? null}
            lane={gutterHost?.lane ?? GLYPH_MARGIN_LANE_CENTER}
            boxes={gutterBoxes}
            onToggle={fileHunks.toggle}
          />
        ) : null}
      </div>
    </div>
  )
}

function keyFor(item: DiffFileItem | undefined): string | null {
  return item ? `${item.kind}:${item.path}` : null
}

/** One stop for the change stepper: a line, and which editor it is a line of. */
type DiffStep = { line: number; side: 'original' | 'modified' }

/** Monaco's own idea of a change, as a stop. Used only when git has none to
 *  give — see `gitStepsRef`. */
function monacoStep(change: Monaco.editor.ILineChange): DiffStep {
  return change.modifiedEndLineNumber === 0
    ? { line: Math.max(1, change.originalStartLineNumber), side: 'original' }
    : { line: Math.max(1, change.modifiedStartLineNumber), side: 'modified' }
}
