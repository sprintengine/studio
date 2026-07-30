import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useGitStatus, type GitRepoState } from '../../hooks/useGitStatus'
import { detectLanguage, isImageFile } from '../../utils/files'
import { MONO_FONT_STACK } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import {
  buildDiffFileList,
  findDiffFocusIndex,
  type DiffFileItem,
} from './diffFileList'
import { nextDiffPosition, resolveEdgeHunkIndex } from './diffNavigation'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'

type Props = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
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

async function loadDiffContent(repoRoot: string, item: DiffFileItem): Promise<DiffContent> {
  const language = detectLanguage(item.relativePath)

  if (isImageFile(item.path) || isImageFile(item.relativePath)) {
    return { state: 'binary' }
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'down' ? 'Next change' : 'Previous change'}
      className="app-no-drag inline-flex h-7 w-7 items-center justify-center bg-transparent text-[color:var(--text-subtle)] transition-colors hover:text-[color:var(--text-default)] disabled:opacity-40 disabled:hover:text-[color:var(--text-subtle)] focus-visible:focus-ring"
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
    </button>
  )
}

function CenteredMessage({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div
      className={`flex h-full items-center justify-center px-6 text-center text-body font-mono ${
        tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-disabled)]'
      }`}
    >
      {children}
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
  if (content.state === 'error') return <CenteredMessage tone="error">{content.message}</CenteredMessage>
  if (content.state === 'binary') return <CenteredMessage>Binary file — diff not shown.</CenteredMessage>
  if (content.state === 'too-large') return <CenteredMessage>File is too large to diff.</CenteredMessage>

  return (
    <DiffEditor
      height="100%"
      theme={monacoTheme}
      original={content.original}
      modified={content.modified}
      language={content.language}
      keepCurrentOriginalModel={false}
      keepCurrentModifiedModel={false}
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

export default function DiffViewerWindow({ repoRoot, focusPath, focusKind }: Props) {
  const { status, repoState } = useGitStatus(repoRoot)
  const isMac = window.api.platform === 'darwin'
  const monacoTheme = useMonacoBaseTheme()

  const items = useMemo(() => buildDiffFileList(status), [status])

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
  }, [repoRoot, currentItem?.path, currentItem?.kind])

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
  // mirror the usual IDE/Monaco idiom; Escape closes the window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || (event.key === 'F7' && !event.shiftKey)) {
        event.preventDefault()
        navigate('next')
      } else if (event.key === 'ArrowUp' || (event.key === 'F7' && event.shiftKey)) {
        event.preventDefault()
        navigate('prev')
      } else if (event.key === 'Escape') {
        void window.api.windowClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  const positionLabel =
    items.length > 0 && currentIndex >= 0 ? `File ${currentIndex + 1} of ${items.length}` : 'No changes'

  return (
    <div className="flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <div
        className={`app-drag relative flex ${TITLE_BAR_HEIGHT} shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pr-2 ${
          isMac ? TRAFFIC_LIGHT_INSET : 'pl-3'
        }`}
      >
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
              {currentItem.kind === 'staged' ? ' · staged' : ' · unstaged'}
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
