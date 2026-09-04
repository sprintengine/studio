import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useGitStatus, type GitRepoState } from '../../hooks/useGitStatus'
import { detectLanguage, isImageFile } from '../../utils/files'
import { joinFilePath } from '../../utils/paths'
import { BranchStepStrip } from './BranchStepStrip'
import { branchItemsFrom, scopeNote, stripEntriesFrom, type BranchDiffItem } from './branchSteps'
import { useBranchSteps } from './useBranchSteps'
import { MONO_FONT_STACK } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import {
  buildDiffFileList,
  findDiffFocusIndex,
  type DiffFileItem,
} from './diffFileList'
import { nextDiffPosition, resolveEdgeHunkIndex } from './diffNavigation'
import { EmptyState, IconButton, InlineNotice, Tooltip } from '../ui'
import { FOCUS_RING_INSET_CLASS } from '../ui/tokens'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'
import { openDiffWindow } from './openDiffWindow'

// The diff viewer: the changed-file list, a read-only Monaco DiffEditor, and
// hunk navigation that flows across files. Two hosts render it — the
// standalone aux window (DiffViewerWindow) and the workspace pane's Diff tab
// (browser-pane epic) — and the only thing that differs is the band above it:
// the window draws a title bar with the traffic-light inset and closes on
// Escape; the pane draws a panel-header band with an "Open in separate
// window" action and scopes its arrow keys to itself.

export type DiffViewerVariant = 'window' | 'pane'

type Props = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
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
  stage: 'head' | 'index'
): Promise<{ content: string; binary: boolean; tooLarge: boolean } | { error: string }> {
  const result = await window.api.getGitFileAtStage(repoRoot, path, stage)
  if (!result.ok) return { error: result.message }
  return { content: result.content, binary: result.binary, tooLarge: result.tooLarge }
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
// honest render for that is an empty pane, not a read failure.
async function readRevSide(
  repoRoot: string,
  path: string,
  rev: string | 'worktree' | null
): Promise<{ content: string; binary: boolean }> {
  if (rev === null) return { content: '', binary: false }
  if (rev === 'worktree') return readWorktreeSide(joinFilePath(repoRoot, path))
  const content = await window.api.getGitFileAtRev(repoRoot, rev, path)
  if (content === null) return { content: '', binary: false }
  return { content, binary: content.includes(NUL) }
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

function ChevronButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'up' | 'down'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <IconButton
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'down' ? 'Next change' : 'Previous change'}
      className="app-no-drag"
    >
      <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
        <path
          d={direction === 'down' ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconButton>
  )
}

function OpenInWindowButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Open in separate window" placement="bottom">
      <IconButton onClick={onClick} aria-label="Open in separate window" className="app-no-drag">
        <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
          <path d="M6.5 3H3v10h10V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.5 3H13v3.5M13 3 7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}

// The aux window's empty states were their own dialect (MC-2115): bare centred
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

function DiffBody({
  content,
  repoState,
  currentItem,
  onMount,
  monacoTheme,
}: {
  content: DiffContent
  repoState: GitRepoState
  currentItem: DiffFileItem | null
  onMount: DiffOnMount
  monacoTheme: 'vs' | 'vs-dark'
}) {
  if (repoState === 'not-git') return <CenteredMessage>Not a Git repository.</CenteredMessage>
  if (!currentItem) {
    if (repoState === 'loading' || repoState === 'idle') return <CenteredMessage>Loading changes…</CenteredMessage>
    return <CenteredMessage>No changed files.</CenteredMessage>
  }
  if (content.state === 'loading') return <CenteredMessage>Loading diff…</CenteredMessage>
  if (content.state === 'error') return <CenteredError message={content.message} />
  if (content.state === 'binary') return <CenteredMessage>Binary file — diff not shown.</CenteredMessage>
  if (content.state === 'too-large') return <CenteredMessage>File is too large to diff.</CenteredMessage>

  return (
    <DiffEditor
      height="100%"
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
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontSize: 13,
        fontFamily: MONO_FONT_STACK,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        contextmenu: false,
        renderOverviewRuler: true,
      }}
      onMount={onMount}
    />
  )
}

export function DiffViewer({
  repoRoot,
  focusPath,
  focusKind,
  variant = 'window',
  onItemCountChange,
  branchSteps = false,
}: Props) {
  const { status, repoState } = useGitStatus(repoRoot)
  const isMac = window.api.platform === 'darwin'
  const monacoTheme = useMonacoBaseTheme()

  // The branch's steps, re-read when the git watcher says the tree moved. The
  // status snapshot is the revision token: a rebase or a commit changes it, and
  // a strip held across one would be confidently wrong about hashes that no
  // longer exist.
  const steps = useBranchSteps(repoRoot, branchSteps, status)
  const stripEntries = useMemo(() => stripEntriesFrom(steps.snapshot), [steps.snapshot])
  const stepNote = useMemo(() => scopeNote(steps.snapshot), [steps.snapshot])
  const workingItems = useMemo(() => buildDiffFileList(status), [status])
  const branchItems = useMemo(
    () => branchItemsFrom(steps.diff, steps.selection, steps.snapshot, repoRoot),
    [steps.diff, steps.selection, steps.snapshot, repoRoot]
  )
  const items = branchSteps ? branchItems : workingItems

  useEffect(() => {
    onItemCountChange?.(items.length)
  }, [items.length, onItemCountChange])
  useEffect(() => () => onItemCountChange?.(null), [onItemCountChange])

  const [currentIndex, setCurrentIndex] = useState(-1)
  const initializedRef = useRef(false)
  const currentPathKeyRef = useRef<string | null>(null)

  // Initialise focus once the first status snapshot arrives, then keep the cursor
  // anchored to the same (path, kind) as the list changes underneath us (file
  // saved / staged). If the focused entry disappears, clamp into range.
  useEffect(() => {
    if (items.length === 0) {
      setCurrentIndex(-1)
      currentPathKeyRef.current = null
      return
    }
    if (!initializedRef.current) {
      const index = findDiffFocusIndex(items, focusPath, focusKind)
      const resolved = index >= 0 ? index : 0
      initializedRef.current = true
      setCurrentIndex(resolved)
      currentPathKeyRef.current = keyFor(items[resolved])
      return
    }
    const previousKey = currentPathKeyRef.current
    const keptIndex = previousKey ? items.findIndex((item) => keyFor(item) === previousKey) : -1
    if (keptIndex >= 0) {
      if (keptIndex !== currentIndex) setCurrentIndex(keptIndex)
      return
    }
    const clamped = Math.min(Math.max(currentIndex, 0), items.length - 1)
    setCurrentIndex(clamped)
    currentPathKeyRef.current = keyFor(items[clamped])
  }, [items, focusPath, focusKind, currentIndex])

  const currentItem = currentIndex >= 0 ? items[currentIndex] ?? null : null

  const [content, setContent] = useState<DiffContent>({ state: 'loading' })
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const hunksRef = useRef<Monaco.editor.ILineChange[]>([])
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
    hunkIndexRef.current = 0
    pendingEdgeRef.current = null
    currentPathKeyRef.current = keyFor(items[index])
    setCurrentIndex(index)
  }, [focusPath, focusKind, items])

  useEffect(() => {
    if (!currentItem) {
      setContent({ state: 'loading' })
      return
    }
    let cancelled = false
    setContent({ state: 'loading' })
    hunksRef.current = []
    hunkIndexRef.current = 0
    void loadDiffContent(repoRoot, currentItem).then((next) => {
      if (!cancelled) setContent(next)
    })
    return () => {
      cancelled = true
    }
  }, [
    repoRoot,
    currentItem?.path,
    currentItem?.kind,
    // Stepping to another commit leaves path and kind identical while both sides
    // move; without these the pane would keep showing the previous step's diff.
    (currentItem as BranchDiffItem | null)?.originalRev,
    (currentItem as BranchDiffItem | null)?.modifiedRev,
  ])

  const revealHunk = useCallback((index: number) => {
    const editor = diffEditorRef.current
    const hunks = hunksRef.current
    if (!editor || hunks.length === 0) return
    const clamped = Math.min(Math.max(index, 0), hunks.length - 1)
    const hunk = hunks[clamped]
    hunkIndexRef.current = clamped
    // Pure deletions have modifiedEndLineNumber === 0; reveal the original side
    // there, otherwise reveal the modified side (the diff editor syncs scroll).
    if (hunk.modifiedEndLineNumber === 0) {
      editor.getOriginalEditor().revealLineInCenter(Math.max(1, hunk.originalStartLineNumber))
    } else {
      const modified = editor.getModifiedEditor()
      const line = Math.max(1, hunk.modifiedStartLineNumber)
      modified.revealLineInCenter(line)
      modified.setPosition({ lineNumber: line, column: 1 })
    }
  }, [])

  const handleDiffMount = useCallback<DiffOnMount>(
    (editor) => {
      diffEditorRef.current = editor
      // The models the wrapper created for this mount; it keeps them (see the
      // props), so they are released here once the widget has let go of them.
      const model = editor.getModel()
      editor.onDidDispose(() => {
        window.setTimeout(() => {
          model?.original.dispose()
          model?.modified.dispose()
        }, 0)
      })
      editor.onDidUpdateDiff(() => {
        const changes = editor.getLineChanges() ?? []
        hunksRef.current = changes
        const pending = pendingEdgeRef.current
        if (pending) {
          pendingEdgeRef.current = null
          revealHunk(resolveEdgeHunkIndex(pending, changes.length))
        } else {
          revealHunk(hunkIndexRef.current)
        }
      })
    },
    [revealHunk]
  )

  const navigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (items.length === 0 || currentIndex < 0) return
      const move = nextDiffPosition(
        { fileIndex: currentIndex, hunkIndex: hunkIndexRef.current },
        direction,
        hunksRef.current.length,
        items.length
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
      setCurrentIndex(move.fileIndex)
    },
    [items, currentIndex, revealHunk]
  )

  // The viewer is read-only, so arrows always navigate hunks. F7 / Shift+F7
  // mirror the usual IDE/Monaco idiom. Returns whether the key was taken.
  const handleNavigationKey = useCallback(
    (event: { key: string; shiftKey: boolean; preventDefault: () => void }): boolean => {
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
    [navigate],
  )

  // The window owns its whole keyboard, so the keys are window-wide there and
  // Escape closes it. In the pane the same keys are scoped to the viewer's own
  // focus (a window-wide ArrowDown would hijack every list in the app).
  useEffect(() => {
    if (variant !== 'window') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (handleNavigationKey(event)) return
      if (event.key === 'Escape') void window.api.windowClose()
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
    void openDiffWindow({
      repoRoot,
      focusPath: target?.path ?? focusPath ?? '',
      scope: scope ?? focusKind ?? 'unstaged',
    })
  }, [currentItem, focusKind, focusPath, items, repoRoot])

  const bandClass =
    variant === 'window'
      ? `app-drag relative flex ${TITLE_BAR_HEIGHT} shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pr-2 ${
          isMac ? TRAFFIC_LIGHT_INSET : 'pl-3'
        }`
      // The pane's one band: panel-header geometry (34px, space.lg inset).
      : 'flex h-control-md shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pl-3 pr-2'

  return (
    <div
      className={
        variant === 'window'
          ? 'flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]'
          : `flex h-full w-full flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)] ${FOCUS_RING_INSET_CLASS}`
      }
      tabIndex={variant === 'pane' ? 0 : undefined}
      onKeyDown={variant === 'pane' ? (event) => { handleNavigationKey(event) } : undefined}
    >
      {branchSteps ? (
        <BranchStepStrip
          entries={stripEntries}
          selection={steps.selection}
          onSelect={steps.select}
          note={stepNote}
        />
      ) : null}
      <div className={bandClass}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="truncate text-meta font-medium text-[color:var(--text-default)]"
            title={currentItem?.relativePath}
          >
            {currentItem?.relativePath ?? 'Git Diff'}
          </span>
          {currentItem ? (
            <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">
              {STATUS_LABEL[currentItem.status]}
              {currentItem.kind === 'branch'
                ? ''
                : currentItem.kind === 'staged'
                  ? ' · staged'
                  : ' · unstaged'}
              {currentItem.kind === 'branch' && (currentItem as BranchDiffItem).additions + (currentItem as BranchDiffItem).deletions > 0 ? (
                <span className="ml-1 font-mono tabular-nums">
                  <span className="text-[color:var(--tone-good)]">
                    +{(currentItem as BranchDiffItem).additions}
                  </span>
                  <span className="ml-1 text-[color:var(--tone-error)]">
                    −{(currentItem as BranchDiffItem).deletions}
                  </span>
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <span
          className="app-no-drag shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]"
          aria-live="polite"
        >
          {positionLabel}
        </span>
        <div className="app-no-drag flex shrink-0 items-center">
          <ChevronButton direction="up" disabled={items.length === 0} onClick={() => navigate('prev')} />
          <ChevronButton direction="down" disabled={items.length === 0} onClick={() => navigate('next')} />
          {variant === 'pane' ? <OpenInWindowButton onClick={openInWindow} /> : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <DiffBody content={content} repoState={repoState} currentItem={currentItem} onMount={handleDiffMount} monacoTheme={monacoTheme} />
      </div>
    </div>
  )
}

function keyFor(item: DiffFileItem | undefined): string | null {
  return item ? `${item.kind}:${item.path}` : null
}
