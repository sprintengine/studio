import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'
import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'

type GitPanelMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
}

type GitChangeGroup = {
  title: string
  empty: string
  actionTitle: string
  actionIcon: GitActionIconKind
  action: (path: string) => Promise<unknown>
  secondaryAction?: {
    title: string
    icon: GitActionIconKind
    action: (entry: GitStatusEntry) => Promise<unknown>
  }
  bulkActions?: GitBulkAction[]
  entries: GitStatusEntry[]
}

type GitActionIconKind = 'stage' | 'unstage' | 'revert'

type GitBulkAction = {
  label: string
  title: string
  danger?: boolean
  action: () => Promise<unknown>
}

type GitHistoryState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: GitHistorySnapshot }
  | { status: 'error'; message: string }

function RefreshGitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GitActionIcon({ kind }: { kind: GitActionIconKind }) {
  if (kind === 'stage') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
        <path d="M8 3.25V12.75M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'unstage') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
        <path d="M4.25 8H11.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <path
        d="M5.2 4.5H2.85V2.15M3.1 7.8A4.95 4.95 0 1 0 4.45 4.4L2.85 6"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function sortedEntries(entries: GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function splitGitPath(relativePath: string): { directory: string; filename: string } {
  const lastSlashIndex = relativePath.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return { directory: '', filename: relativePath }
  }

  return {
    directory: relativePath.slice(0, lastSlashIndex),
    filename: relativePath.slice(lastSlashIndex + 1),
  }
}

function resultMessage(result: GitCommandResult, fallback: string): GitPanelMessage {
  if (result.ok) {
    return { tone: 'success', text: fallback }
  }

  return { tone: 'error', text: result.message || result.stderr.trim() || 'Git command failed.' }
}

function syncStatusLabel(branches: GitBranchSnapshot | null): string {
  if (!branches) return 'Checking branch'
  if (branches.ahead && branches.behind) return `Ahead ${branches.ahead}, behind ${branches.behind}`
  if (branches.ahead) return `Ahead ${branches.ahead}`
  if (branches.behind) return `Behind ${branches.behind}`
  return 'Up to date'
}

export default function GitPanel({ workspaceId }: { workspaceId: string }) {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const { repoRoot, status, refresh } = useGitStatus(folderPath)
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [history, setHistory] = useState<GitHistoryState>({ status: 'loading' })
  const [message, setMessage] = useState<GitPanelMessage | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const refreshBranches = useCallback(async () => {
    if (!repoRoot || typeof window.api.getGitBranches !== 'function') {
      setBranches(null)
      return
    }

    try {
      setBranches(await window.api.getGitBranches(repoRoot))
    } catch {
      setBranches(null)
    }
  }, [repoRoot])

  const refreshHistory = useCallback(async () => {
    if (!repoRoot || typeof window.api.getGitHistory !== 'function') {
      setHistory({
        status: 'error',
        message: 'Restart the app to enable commit history.',
      })
      return
    }

    setHistory({ status: 'loading' })
    try {
      setHistory({ status: 'ready', snapshot: await window.api.getGitHistory(repoRoot, 12) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setHistory({
        status: 'error',
        message: message.includes("No handler registered for 'git:get-history'")
          ? 'Restart the app to enable commit history.'
          : 'Unable to load commits.',
      })
    }
  }, [repoRoot])

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshBranches(), refreshHistory()])
  }, [refresh, refreshBranches, refreshHistory])

  useEffect(() => {
    void refreshBranches()
    void refreshHistory()
  }, [refreshBranches, refreshHistory])

  const stagedEntries = useMemo(
    () => sortedEntries(Object.values(status?.files ?? {}).filter((entry) => entry.staged)),
    [status]
  )
  const unstagedEntries = useMemo(
    () => sortedEntries(Object.values(status?.files ?? {}).filter((entry) => entry.unstaged)),
    [status]
  )
  const allEntries = useMemo(() => sortedEntries(Object.values(status?.files ?? {})), [status])
  const branchOptions = branches?.branches ?? []
  const readyToCommit = stagedEntries.length > 0 && Boolean(commitMessage.trim())

  const runAction = async (
    label: string,
    action: () => Promise<GitCommandResult>,
    success: string
  ): Promise<GitCommandResult | null> => {
    if (busy) return null
    setBusy(label)
    setMessage({ tone: 'neutral', text: `${label}...` })
    try {
      const result = await action()
      setMessage(resultMessage(result, success))
      if (result.ok) {
        await refreshAll()
      }
      return result
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return null
    } finally {
      setBusy(null)
    }
  }

  const stagePath = (path: string) =>
    runAction('Staging file', () => window.api.stageGitPaths(repoRoot!, [path]), 'Staged file.')
  const unstagePath = (path: string) =>
    runAction('Unstaging file', () => window.api.unstageGitPaths(repoRoot!, [path]), 'Unstaged file.')
  const revertPath = (entry: GitStatusEntry) => {
    const confirmed = window.confirm(
      `Revert all changes to ${entry.relativePath}? This cannot be undone from Multicode.`
    )
    if (!confirmed) return Promise.resolve(null)

    return runAction('Reverting file', () => window.api.revertGitPaths(repoRoot!, [entry.path]), 'Reverted file.')
  }
  const discardUnstagedChanges = () => {
    const confirmed = window.confirm(
      'Roll back all unstaged changes? This will discard unstaged edits and remove untracked files.'
    )
    if (!confirmed) return Promise.resolve(null)

    return runAction(
      'Rolling back unstaged changes',
      () => window.api.discardUnstagedGitChanges(repoRoot!, []),
      'Rolled back unstaged changes.'
    )
  }

  const groups: GitChangeGroup[] = [
    {
      title: `Staged (${stagedEntries.length})`,
      empty: 'No staged changes',
      actionTitle: 'Unstage this file',
      actionIcon: 'unstage',
      action: unstagePath,
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
        action: revertPath,
      },
      bulkActions: [
        {
          label: 'Unstage All',
          title: 'Unstage all staged changes',
          action: () => runAction('Unstaging all', () => window.api.unstageGitPaths(repoRoot!, []), 'Unstaged all files.'),
        },
      ],
      entries: stagedEntries,
    },
    {
      title: `Unstaged (${unstagedEntries.length})`,
      empty: 'No unstaged changes',
      actionTitle: 'Stage this file',
      actionIcon: 'stage',
      action: stagePath,
      secondaryAction: {
        title: 'Revert this file',
        icon: 'revert',
        action: revertPath,
      },
      bulkActions: [
        {
          label: 'Stage All',
          title: 'Stage all changes',
          action: () => runAction('Staging all', () => window.api.stageGitPaths(repoRoot!, []), 'Staged all changes.'),
        },
        {
          label: 'Discard',
          title: 'Roll back all unstaged changes',
          danger: true,
          action: discardUnstagedChanges,
        },
      ],
      entries: unstagedEntries,
    },
  ]

  const handleCommit = async () => {
    if (!repoRoot) return
    const result = await runAction(
      'Committing',
      () => window.api.commitGitChanges(repoRoot, commitMessage),
      'Committed changes.'
    )
    if (result?.ok) setCommitMessage('')
  }

  const handlePush = async () => {
    if (!repoRoot) return
    await runAction('Pushing', () => window.api.pushGitBranch(repoRoot), 'Pushed branch.')
  }

  const handleSwitchBranch = async (branchName: string) => {
    if (!repoRoot || !branchName || branchName === branches?.current) return
    await runAction(
      'Switching branch',
      () => window.api.switchGitBranch(repoRoot, branchName),
      `Switched to ${branchName}.`
    )
  }

  const handleOpenFile = async (entry: GitStatusEntry) => {
    const name = entry.relativePath.split('/').filter(Boolean).pop() ?? entry.relativePath
    let content = ''

    try {
      content = await window.api.readfile(entry.path)
    } catch {
      if (repoRoot && typeof window.api.getGitFileBase === 'function') {
        const result = await window.api.getGitFileBase(repoRoot, entry.path)
        content = result.ok ? result.content : ''
      }
    }

    openFile(workspaceId, entry.path, name, content)
    focusOrAddComponentTab(workspaceId, 'editor', 'Editor')
  }

  if (!folderPath) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d0e11] px-6 text-center text-[12px] text-[#5a5a63]">
        Open a folder to use Git controls.
      </div>
    )
  }

  if (!repoRoot) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0d0e11] px-6 text-center text-[12px] text-[#5a5a63]">
        This folder is not a Git repository.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d0e11] text-[#d7d7dc]">
      <div className="border-b border-[#1b1c21] bg-[#101115]">
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
          <div className="min-w-0 flex-1">
            <select
              value={branches?.current ?? ''}
              onChange={(event) => void handleSwitchBranch(event.target.value)}
              disabled={Boolean(busy) || branchOptions.length === 0}
              className="block h-5 max-w-full rounded-md border border-transparent bg-transparent px-1 font-mono text-[12px] font-semibold text-[#ececee] outline-none transition-colors hover:bg-[#1a1b20] focus:border-[#303139] focus:bg-[#090a0c] disabled:opacity-50"
              aria-label="Current branch"
            >
              {branchOptions.length === 0 ? (
                <option value="">{branches?.current ?? 'detached'}</option>
              ) : null}
              {branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </select>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[#6f7480]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#30d158]" aria-hidden="true" />
              <span className="truncate">{syncStatusLabel(branches)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={Boolean(busy)}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#838896]"
            title="Refresh Git status"
            aria-label="Refresh Git status"
          >
            <RefreshGitIcon />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {allEntries.length === 0 ? (
            <div className="py-2 text-[12px] text-[#6f7480]">Working tree clean</div>
          ) : (
            groups.map((group) => (
              <ChangeGroup
                key={group.title}
                group={group}
                busy={busy}
                onOpenFile={handleOpenFile}
              />
            ))
          )}
        </div>

        <CommitHistory
          history={history}
          open={historyOpen}
          onToggle={() => setHistoryOpen((open) => !open)}
        />

        <CommitComposer
          busy={busy}
          commitMessage={commitMessage}
          message={message}
          readyToCommit={readyToCommit}
          stagedCount={stagedEntries.length}
          onCommit={handleCommit}
          onCommitMessageChange={setCommitMessage}
          onPush={handlePush}
        />
      </div>
    </div>
  )
}

function ChangeGroup({
  group,
  busy,
  onOpenFile,
}: {
  group: GitChangeGroup
  busy: string | null
  onOpenFile: (entry: GitStatusEntry) => Promise<void>
}) {
  return (
    <section className="mb-4">
      <div className="mb-1 flex h-6 items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">{group.title}</div>
        {group.bulkActions && group.entries.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {group.bulkActions.map((bulkAction) => (
              <button
                key={bulkAction.title}
                type="button"
                onClick={() => void bulkAction.action()}
                disabled={Boolean(busy)}
                className={`inline-flex h-6 shrink-0 items-center justify-center rounded-md px-2 text-[11px] font-semibold leading-none transition-colors disabled:opacity-30 ${
                  bulkAction.danger
                    ? 'text-[#b97074] hover:bg-[#2a1518] hover:text-[#ff8a8e]'
                    : 'text-[#8a8a92] hover:bg-[#1a1b20] hover:text-[#ececee]'
                }`}
                title={bulkAction.title}
                aria-label={bulkAction.title}
              >
                {bulkAction.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {group.entries.length === 0 ? (
        <div className="py-1.5 text-[11px] text-[#5a5a63]">{group.empty}</div>
      ) : (
        <div className="space-y-1">
          {group.entries.map((entry) => {
            const appearance = getGitStatusAppearance(entry.status)
            const pathParts = splitGitPath(entry.relativePath)
            return (
              <div
                key={`${group.title}:${entry.path}`}
                role="button"
                tabIndex={0}
                onClick={() => void onOpenFile(entry)}
                onKeyDown={(event) => {
                  if (event.currentTarget !== event.target) return
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  void onOpenFile(entry)
                }}
                className="group flex min-h-[26px] items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#ececee]"
                title={`Open ${entry.relativePath}`}
              >
                <span className={`flex min-w-0 flex-1 items-baseline font-mono ${appearance.textClass}`}>
                  {pathParts.directory ? (
                    <>
                      <span className="min-w-0 shrink truncate opacity-60 [direction:rtl]">
                        {pathParts.directory}
                      </span>
                      <span className="shrink-0 opacity-60">/</span>
                    </>
                  ) : null}
                  <span className="min-w-0 max-w-full shrink-0 truncate">{pathParts.filename}</span>
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void group.action(entry.path)
                  }}
                  disabled={Boolean(busy)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#8a8a92] opacity-70 transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:opacity-30 group-hover:opacity-100"
                  title={group.actionTitle}
                  aria-label={`${group.actionTitle}: ${entry.relativePath}`}
                >
                  <GitActionIcon kind={group.actionIcon} />
                </button>
                {group.secondaryAction ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void group.secondaryAction?.action(entry)
                    }}
                    disabled={Boolean(busy)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#b97074] opacity-70 transition-colors hover:bg-[#2a1518] hover:text-[#ff8a8e] focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[#713036] disabled:opacity-30 group-hover:opacity-100"
                    title={group.secondaryAction.title}
                    aria-label={`${group.secondaryAction.title}: ${entry.relativePath}`}
                  >
                    <GitActionIcon kind={group.secondaryAction.icon} />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CommitComposer({
  busy,
  commitMessage,
  message,
  readyToCommit,
  stagedCount,
  onCommit,
  onCommitMessageChange,
  onPush,
}: {
  busy: string | null
  commitMessage: string
  message: GitPanelMessage | null
  readyToCommit: boolean
  stagedCount: number
  onCommit: () => Promise<void>
  onCommitMessageChange: (value: string) => void
  onPush: () => Promise<void>
}) {
  return (
    <section className="shrink-0 border-t border-[#1b1c21] bg-[#101115] px-3 py-3">
      <textarea
        value={commitMessage}
        onChange={(event) => onCommitMessageChange(event.target.value)}
        placeholder="Commit message"
        className="h-16 w-full resize-none rounded-md border border-[#1f2025] bg-[#090a0c] px-2.5 py-2 text-[12px] text-[#ececee] outline-none placeholder:text-[#5a5a63] transition-colors focus:border-[#3a3d49]"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-[#6f7480]">
          {stagedCount > 0 ? `${stagedCount} staged` : 'Nothing staged'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onPush()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md px-2.5 text-[11px] font-semibold text-[#8a8f9b] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-default disabled:text-[#4f535c] disabled:hover:bg-transparent"
          >
            Push
          </button>
          <button
            type="button"
            onClick={() => void onCommit()}
            disabled={Boolean(busy) || !readyToCommit}
            className="h-8 rounded-md border border-[#3a3d49] bg-[#ececee] px-3 text-[11px] font-semibold text-[#111216] transition-colors hover:bg-white disabled:border-[#24252b] disabled:bg-[#15161a] disabled:text-[#5a5a63]"
          >
            Commit
          </button>
        </div>
      </div>
      {message ? (
        <div
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-2 max-h-20 overflow-y-auto rounded-md px-2.5 py-2 text-[11px] [overflow-wrap:anywhere] ${
            message.tone === 'error'
              ? 'border border-[#713036] bg-[#311417] text-[#ff8a8e]'
              : message.tone === 'success'
                ? 'bg-transparent px-0 py-0 text-[#8a8f9b]'
                : 'bg-[#15161a] text-[#9a9aa2]'
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </section>
  )
}

function CommitHistory({
  history,
  open,
  onToggle,
}: {
  history: GitHistoryState
  open: boolean
  onToggle: () => void
}) {
  const commits = history.status === 'ready' ? history.snapshot.commits : []

  return (
    <section className="shrink-0 border-t border-[#1b1c21] bg-[#0d0e11]">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-9 w-full items-center justify-between gap-2 px-3 text-left transition-colors hover:bg-[#15161a]"
        aria-expanded={open}
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">History</span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-[#5a5a63]">
          {commits.length ? `${commits.length} recent` : ''}
          <svg
            className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open ? (
        history.status === 'loading' ? (
          <div className="px-3 pb-3 text-[11px] text-[#5a5a63]">Loading commits...</div>
        ) : history.status === 'error' ? (
          <div className="px-3 pb-3 text-[11px] text-[#8a8a92]">{history.message}</div>
        ) : commits.length === 0 ? (
          <div className="px-3 pb-3 text-[11px] text-[#5a5a63]">No commits yet</div>
        ) : (
          <div className="max-h-44 space-y-1.5 overflow-y-auto px-3 pb-3">
          {commits.map((commit) => (
            <div
              key={commit.hash}
              className="group flex min-h-[42px] items-start gap-2 rounded-md px-1.5 py-1.5 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#ececee]"
              title={commit.subject}
            >
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full border border-[#3a3d49]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[#d7d7dc] group-hover:text-[#ececee]">{commit.subject}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[#5a5a63]">
                  <span className="font-mono text-[#8a8a92]">{commit.shortHash}</span>
                  <span>{commit.date}</span>
                  <span className="min-w-0 truncate">{commit.author}</span>
                </div>
              </div>
              {commit.refs.length > 0 ? (
                <span className="mt-0.5 max-w-[76px] shrink-0 truncate rounded-full bg-[#15161a] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[#8a8a92]">
                  {commit.refs[0].replace(/^HEAD -> /, '')}
                </span>
              ) : null}
            </div>
          ))}
          </div>
        )
      ) : null}
    </section>
  )
}
