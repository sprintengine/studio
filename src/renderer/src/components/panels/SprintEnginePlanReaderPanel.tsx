import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { renderMarkdown } from '../../utils/markdown'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import {
  GhostButton,
  InlineNotice,
  OverflowMenu,
  PanelHeader,
  type OverflowMenuItem,
} from '../ui'
import {
  getSprintEnginePlanFilePath,
  getSprintEngineRootDirectoryPath,
} from '../../utils/sprintengineStateFile'

type Props = {
  workspaceId: string
  onClose: () => void
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
type ViewMode = 'preview' | 'source'

const TITLE_ID = 'sprintengine-plan-reader-title'

export default function SprintEnginePlanReaderPanel({ workspaceId, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const openFile = useWorkspaceStore((s) => s.openFile)
  const folderPath = workspace?.folderPath ?? null
  const sprintEngineContext = workspace?.sprintEngineContext ?? null

  const planFilePath = useMemo(
    () =>
      folderPath && sprintEngineContext
        ? getSprintEnginePlanFilePath(folderPath, sprintEngineContext.teamSlug)
        : null,
    [folderPath, sprintEngineContext]
  )

  const [mode, setMode] = useState<ViewMode>('preview')
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadPlan = useCallback(async () => {
    if (!folderPath || !sprintEngineContext) {
      setStatus('error')
      setError(
        !folderPath
          ? 'Choose a workspace folder before reading the Sprint Engine plan.'
          : 'This Sprint Engine workspace is missing its selected team context.'
      )
      return
    }

    const sprintEngineRootDirectory = getSprintEngineRootDirectoryPath(folderPath)
    const teamDirectoryPath = sprintEngineContext.teamDirectoryPath
    const targetPath = getSprintEnginePlanFilePath(folderPath, sprintEngineContext.teamSlug)

    setStatus('loading')
    setError(null)

    try {
      await window.api.ensureDir(folderPath, 'sprintengine')
      await window.api.ensureDir(sprintEngineRootDirectory, sprintEngineContext.teamSlug)

      let nextContent = ''
      try {
        nextContent = await window.api.readfile(targetPath)
      } catch {
        nextContent = ''
      }

      setContent(nextContent)
      setStatus('ready')
    } catch (loadError) {
      setStatus('error')
      setContent('')
      setError(
        loadError instanceof Error
          ? loadError.message
          : `Failed to load plan from ${teamDirectoryPath}.`
      )
    }
  }, [folderPath, sprintEngineContext])

  useEffect(() => {
    void loadPlan()
  }, [loadPlan])

  const openInEditor = useCallback(async () => {
    if (!planFilePath) return
    let nextContent = content
    if (!nextContent) {
      try {
        nextContent = await window.api.readfile(planFilePath)
      } catch {
        nextContent = ''
      }
    }
    openFile(workspaceId, planFilePath, 'plan.md', nextContent)
    focusOrAddFileTab(workspaceId, planFilePath, 'plan.md')
    onClose()
  }, [content, onClose, openFile, planFilePath, workspaceId])

  const overflowItems = useMemo<OverflowMenuItem[]>(() => {
    const items: OverflowMenuItem[] = [
      {
        id: 'toggle-mode',
        label: mode === 'preview' ? 'Show source' : 'Show preview',
        onSelect: () => setMode((current) => (current === 'preview' ? 'source' : 'preview')),
      },
    ]
    if (planFilePath) {
      items.push({
        id: 'open-editor',
        label: 'Open in editor',
        onSelect: () => void openInEditor(),
      })
    }
    items.push({ kind: 'separator', id: 'sep' })
    items.push({ id: 'close', label: 'Close', onSelect: onClose })
    return items
  }, [mode, openInEditor, planFilePath, onClose])

  return (
    <section
      aria-labelledby={TITLE_ID}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
        <PanelHeader
          tool="sprintengine"
          title="Architect plan"
          titleId={TITLE_ID}
          subtitle={planFilePath ?? '.multi-code/sprintengine/<team>/plan.md'}
          primaryAction={
            <GhostButton onClick={() => void loadPlan()} disabled={status === 'loading'}>
              {status === 'loading' ? 'Loading…' : 'Refresh'}
            </GhostButton>
          }
          overflow={<OverflowMenu ariaLabel="Plan reader overflow" items={overflowItems} />}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-5 py-5">
          {status === 'loading' ? (
            <div className="text-[13px] text-[color:var(--text-muted)]">Loading plan…</div>
          ) : null}
          {status === 'error' ? (
            <InlineNotice tone="error">{error ?? 'Failed to load plan.'}</InlineNotice>
          ) : null}
          {status === 'ready' && mode === 'preview' ? (
            <div className="mx-auto max-w-4xl text-[13px] leading-6 text-[color:var(--text-default)]">
              {content ? (
                renderMarkdown(content)
              ) : (
                <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[color:var(--text-muted)]">
                  No architect plan has been written yet.
                </div>
              )}
            </div>
          ) : null}
          {status === 'ready' && mode === 'source' ? (
            <pre className="min-h-[420px] overflow-x-auto rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-4 text-[13px] leading-6 text-[color:var(--text-default)]">
              <code>{content}</code>
            </pre>
          ) : null}
        </div>
      </div>
    </section>
  )
}
