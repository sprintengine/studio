import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import { renderMarkdown } from '../../utils/markdown'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
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

  const toolbar = (
    <>
      <button
        type="button"
        onClick={() => setMode((current) => (current === 'preview' ? 'source' : 'preview'))}
        className="h-8 rounded-md border border-[#24252b] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] interactive transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
      >
        {mode === 'preview' ? 'Source' : 'Preview'}
      </button>
      <button
        type="button"
        onClick={() => void loadPlan()}
        className="h-8 rounded-md border border-[#24252b] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] interactive transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
      >
        Refresh
      </button>
      {planFilePath ? (
        <button
          type="button"
          onClick={() => void openInEditor()}
          className="h-8 rounded-md border border-[#24252b] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] interactive transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
        >
          Open in editor
        </button>
      ) : null}
    </>
  )

  return (
    <WorkspacePanel
      title="Architect Plan"
      subtitle={planFilePath ?? '.multicode/sprintengine/<team>/plan.md'}
      titleId="sprintengine-plan-reader-title"
      onClose={onClose}
      closeLabel="Close plan reader"
      toolbar={toolbar}
      contentClassName="w-full max-w-[1040px] px-5 py-5"
    >
      {status === 'loading' ? (
        <div className="text-[13px] text-[#9a9aa2]">Loading plan...</div>
      ) : null}
      {status === 'error' ? (
        <div className="rounded-md border-l-2 border-[#ff787c] bg-[#1c1414] px-3 py-2 text-[13px] leading-6 text-[#ffb3b5]">
          {error ?? 'Failed to load plan.'}
        </div>
      ) : null}
      {status === 'ready' && mode === 'preview' ? (
        <div className="mx-auto max-w-4xl text-[13px] leading-6 text-[#d7d7dc]">
          {content
            ? renderMarkdown(content)
            : (
              <div className="border-l-2 border-[#303139] pl-3 text-[#9a9aa2]">
                No architect plan has been written yet.
              </div>
            )}
        </div>
      ) : null}
      {status === 'ready' && mode === 'source' ? (
        <pre className="min-h-[420px] overflow-x-auto rounded-md border border-[#24252b] bg-[#08090b] p-4 text-[13px] leading-6 text-[#d7d7dc]">
          <code>{content}</code>
        </pre>
      ) : null}
    </WorkspacePanel>
  )
}
