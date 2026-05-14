import React, { useEffect, useMemo, useState } from 'react'
import MonacoEditor from '@monaco-editor/react'
import {
  combineConflictSides,
  hasGitConflictMarkers,
  parseGitConflictBlocks,
  replaceGitConflictBlock,
} from '../../utils/gitConflictMarkers'
import { Section } from '../ui'

type ResolverState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; conflict: GitConflictFileContent; content: string; saving: boolean; message: string | null }

type Props = {
  workspaceId: string
  repoRoot: string
  filePath: string
}

function filename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function languageForPath(path: string): string | undefined {
  const extension = filename(path).split('.').pop()?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
      return 'markdown'
    case 'py':
      return 'python'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    default:
      return undefined
  }
}

export default function GitConflictResolverPanel({ repoRoot, filePath }: Props) {
  const [state, setState] = useState<ResolverState>({ status: 'loading' })
  const language = languageForPath(filePath)
  const blocks = useMemo(
    () => state.status === 'ready' ? parseGitConflictBlocks(state.content) : [],
    [state]
  )

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    const load = async () => {
      if (typeof window.api.getGitConflictFile !== 'function') {
        setState({ status: 'error', message: 'Restart the app to enable the conflict resolver.' })
        return
      }

      const conflict = await window.api.getGitConflictFile(repoRoot, filePath)
      if (cancelled) return
      if (!conflict) {
        setState({ status: 'error', message: 'This file is not available as a Git conflict.' })
        return
      }

      setState({
        status: 'ready',
        conflict,
        content: conflict.result,
        saving: false,
        message: null,
      })
    }

    void load().catch((error) => {
      if (cancelled) return
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    return () => {
      cancelled = true
    }
  }, [filePath, repoRoot])

  const updateContent = (content: string) => {
    setState((current) => current.status === 'ready' ? { ...current, content } : current)
  }

  const applyBlock = (blockIndex: number, replacement: string) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const nextBlock = parseGitConflictBlocks(current.content)[blockIndex]
      if (!nextBlock) return current
      return {
        ...current,
        content: replaceGitConflictBlock(current.content, nextBlock, replacement),
        message: null,
      }
    })
  }

  const saveResolved = async () => {
    if (state.status !== 'ready' || state.saving) return
    if (hasGitConflictMarkers(state.content)) {
      const confirmed = window.confirm('Conflict markers remain in this file. Mark it resolved anyway?')
      if (!confirmed) return
    }

    setState({ ...state, saving: true, message: null })
    try {
      const result = await window.api.resolveGitConflict(repoRoot, filePath, state.content)
      setState((current) => current.status === 'ready'
        ? {
            ...current,
            saving: false,
            message: result.ok ? 'Saved and marked resolved.' : result.message ?? 'Unable to mark resolved.',
          }
        : current)
    } catch (error) {
      setState((current) => current.status === 'ready'
        ? {
            ...current,
            saving: false,
            message: error instanceof Error ? error.message : String(error),
          }
        : current)
    }
  }

  if (state.status === 'loading') {
    return <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] text-[12px] text-[color:var(--text-disabled)]">Loading conflict...</div>
  }

  if (state.status === 'error') {
    return <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-[12px] text-[color:var(--tone-error)]">{state.message}</div>
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-[12px] font-semibold text-[color:var(--text-strong)]" title={state.conflict.path}>
              {state.conflict.relativePath}
            </div>
            <div className="mt-0.5 text-[10px] text-[color:var(--text-subtle)]">
              Pulled version / Your stashed changes / Final result
            </div>
          </div>
          <button
            type="button"
            onClick={() => void saveResolved()}
            disabled={state.saving}
            className="h-8 shrink-0 rounded-md border border-[color:var(--color-6)] bg-[color:var(--text-strong)] px-3 text-[11px] font-semibold text-[color:var(--bg-surface-raised)] transition-colors hover:bg-white disabled:border-[color:var(--bg-selected)] disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]"
          >
            {state.saving ? 'Saving...' : 'Save & Mark Resolved'}
          </button>
        </div>
        {state.message ? (
          <div className="mt-2 rounded-md border border-[color:var(--color-5)] bg-[color:var(--bg-surface-raised)] px-2.5 py-1.5 text-[11px] text-[color:var(--text-muted)]">
            {state.message}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(170px,32%)_minmax(0,1fr)]">
        <div className="grid min-h-0 grid-cols-2 border-b border-[color:var(--border-default)]">
          <ConflictReadOnlyPane
            title="Pulled version"
            content={state.conflict.ours ?? ''}
            language={language}
            empty="No pulled version for this conflict."
          />
          <ConflictReadOnlyPane
            title="Your stashed changes"
            content={state.conflict.theirs ?? ''}
            language={language}
            empty="No stashed version for this conflict."
          />
        </div>

        <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
            <Section title="Conflicts" count={blocks.length} level={3} inset>
              {blocks.length === 0 ? (
                <div className="text-[11px] text-[color:var(--text-subtle)]">No conflict markers remain.</div>
              ) : (
                <div className="space-y-2">
                  {blocks.map((block) => (
                    <div key={`${block.index}:${block.startOffset}`} className="rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] p-2">
                      <div className="mb-2 text-[11px] font-semibold text-[color:var(--text-default)]">Conflict {block.index + 1}</div>
                      <div className="grid gap-1">
                        <ConflictActionButton label="Use Pulled" onClick={() => applyBlock(block.index, block.ours)} />
                        <ConflictActionButton label="Use Stashed" onClick={() => applyBlock(block.index, block.theirs)} />
                        <ConflictActionButton label="Use Both" onClick={() => applyBlock(block.index, combineConflictSides(block))} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </aside>
          <section className="min-h-0 bg-[color:var(--bg-app)]">
            <MonacoEditor
              height="100%"
              language={language}
              value={state.content}
              theme="vs-dark"
              options={{
                fontSize: 13,
                fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'off',
              }}
              onChange={(value) => updateContent(value ?? '')}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

function ConflictReadOnlyPane({
  title,
  content,
  language,
  empty,
}: {
  title: string
  content: string
  language?: string
  empty: string
}) {
  return (
    <section className="flex min-h-0 flex-col border-r border-[color:var(--border-default)] last:border-r-0">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--text-default)]">
        {title}
      </div>
      {content ? (
        <MonacoEditor
          height="100%"
          language={language}
          value={content}
          theme="vs-dark"
          options={{
            readOnly: true,
            fontSize: 12,
            fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'off',
            lineNumbers: 'on',
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[11px] text-[color:var(--text-disabled)]">
          {empty}
        </div>
      )}
    </section>
  )
}

function ConflictActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md px-2 text-left text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-active)] hover:text-[color:var(--text-strong)]"
    >
      {label}
    </button>
  )
}
