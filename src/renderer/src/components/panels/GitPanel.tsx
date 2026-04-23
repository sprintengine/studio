import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStatus } from '../../hooks/useGitStatus'

type GitPanelMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
}

type GitChangeGroup = {
  title: string
  empty: string
  actionLabel: string
  action: (path: string) => Promise<unknown>
  bulkAction?: {
    label: string
    title: string
    action: () => Promise<unknown>
  }
  entries: GitStatusEntry[]
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

function statusAppearance(status: GitFileStatus): { label: string; textClass: string } {
  switch (status) {
    case 'new':
      return { label: 'A', textClass: 'text-[#7bd7ea] group-hover:text-[#a8edf5]' }
    case 'modified':
      return { label: 'M', textClass: 'text-[#f2a84b] group-hover:text-[#ffc46f]' }
    case 'deleted':
      return { label: 'D', textClass: 'text-[#ff5a5f] line-through decoration-[#ff5a5f]/80 group-hover:text-[#ff787c]' }
    case 'renamed':
      return { label: 'R', textClass: 'text-[#f2a84b] group-hover:text-[#ffc46f]' }
    case 'conflicted':
      return { label: '!', textClass: 'text-[#ff5a5f] group-hover:text-[#ff787c]' }
  }
}

function sortedEntries(entries: GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function resultMessage(result: GitCommandResult, fallback: string): GitPanelMessage {
  if (result.ok) {
    return { tone: 'success', text: result.stdout.trim() || result.stderr.trim() || fallback }
  }

  return { tone: 'error', text: result.message || result.stderr.trim() || 'Git command failed.' }
}

export default function GitPanel({ workspaceId }: { workspaceId: string }) {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const { repoRoot, status, refresh } = useGitStatus(folderPath)
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [history, setHistory] = useState<GitHistoryState>({ status: 'loading' })
  const [message, setMessage] = useState<GitPanelMessage | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

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

  const groups: GitChangeGroup[] = [
    {
      title: `Staged (${stagedEntries.length})`,
      empty: 'No staged changes',
      actionLabel: 'Unstage',
      action: unstagePath,
      entries: stagedEntries,
    },
    {
      title: `Unstaged (${unstagedEntries.length})`,
      empty: 'No unstaged changes',
      actionLabel: 'Stage',
      action: stagePath,
      bulkAction: {
        label: '+',
        title: 'Stage all changes',
        action: () => runAction('Staging all', () => window.api.stageGitPaths(repoRoot!, []), 'Staged all changes.'),
      },
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
      <div className="border-b border-[#1f2025] bg-[#111216]">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
          <select
            value={branches?.current ?? ''}
            onChange={(event) => void handleSwitchBranch(event.target.value)}
            disabled={Boolean(busy) || branchOptions.length === 0}
            className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[11px] text-[#9a9aa2] outline-none transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:border-[#303139] focus:bg-[#090a0c] disabled:opacity-50"
            aria-label="Current branch"
          >
            {branchOptions.length === 0 ? (
              <option value="">{branches?.current ?? 'detached'}</option>
            ) : null}
            {branchOptions.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}{branch.upstream ? ` -> ${branch.upstream}` : ''}
              </option>
            ))}
          </select>
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

        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <div className="flex min-w-0 items-center gap-2 text-[10px] text-[#8a8a92]">
            {!branches ? <span>Checking branch</span> : null}
            {branches?.ahead ? <span>Ahead {branches.ahead}</span> : null}
            {branches?.behind ? <span>Behind {branches.behind}</span> : null}
            {branches && !branches.ahead && !branches.behind ? <span>Up to date</span> : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {allEntries.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-[#5a5a63]">Working tree clean</div>
        ) : (
          groups.map((group) => (
            <ChangeGroup key={group.title} group={group} busy={busy} />
          ))
        )}
        <CommitHistory history={history} />
      </div>

      <div className="border-t border-[#1f2025] bg-[#111216] p-3">
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Commit message"
          className="h-20 w-full resize-none rounded-md border border-[#24252b] bg-[#090a0c] px-2.5 py-2 text-[12px] text-[#ececee] outline-none placeholder:text-[#5a5a63] focus:border-[#303139]"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void runAction('Staging all', () => window.api.stageGitPaths(repoRoot, []), 'Staged all changes.')}
            disabled={Boolean(busy) || unstagedEntries.length === 0}
            className="h-8 rounded-md border border-[#24252b] bg-[#15161a] px-3 text-[11px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-40"
          >
            Stage All
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCommit()}
              disabled={Boolean(busy) || stagedEntries.length === 0 || !commitMessage.trim()}
              className="h-8 rounded-md border border-[#3a3d49] bg-[#17181d] px-3 text-[11px] font-semibold text-[#ececee] transition-colors hover:bg-[#1d1e24] disabled:opacity-40"
            >
              Commit
            </button>
            <button
              type="button"
              onClick={() => void handlePush()}
              disabled={Boolean(busy)}
              className="h-8 rounded-md border border-[#24252b] bg-[#15161a] px-3 text-[11px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-40"
            >
              Push
            </button>
          </div>
        </div>
        {message ? (
          <div
            className={`mt-2 rounded-md border px-2.5 py-2 text-[11px] ${
              message.tone === 'error'
                ? 'border-[#713036] bg-[#311417] text-[#ff8a8e]'
                : message.tone === 'success'
                  ? 'border-[#3a3d49] bg-[#17181d] text-[#d7d7dc]'
                  : 'border-[#303139] bg-[#15161a] text-[#9a9aa2]'
            }`}
          >
            {message.text}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ChangeGroup({ group, busy }: { group: GitChangeGroup; busy: string | null }) {
  return (
    <section className="mb-3">
      <div className="mb-1 flex h-6 items-center justify-between gap-2 px-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">{group.title}</div>
        {group.bulkAction && group.entries.length > 0 ? (
          <button
            type="button"
            onClick={() => void group.bulkAction?.action()}
            disabled={Boolean(busy)}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] font-mono text-[13px] leading-none text-[#8a8a92] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-30"
            title={group.bulkAction.title}
            aria-label={group.bulkAction.title}
          >
            {group.bulkAction.label}
          </button>
        ) : null}
      </div>
      {group.entries.length === 0 ? (
        <div className="px-1 py-1.5 text-[11px] text-[#5a5a63]">{group.empty}</div>
      ) : (
        <div className="space-y-1">
          {group.entries.map((entry) => {
            const appearance = statusAppearance(entry.status)
            return (
              <div
                key={`${group.title}:${entry.path}`}
                className="group flex min-h-[26px] items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#ececee]"
              >
                <span className={`min-w-0 flex-1 truncate font-mono ${appearance.textClass}`}>
                  {entry.relativePath}
                </span>
                <span className={`ml-auto shrink-0 font-mono text-[10px] font-bold ${appearance.textClass} opacity-80`}>
                  {appearance.label}
                </span>
                <button
                  type="button"
                  onClick={() => void group.action(entry.path)}
                  disabled={Boolean(busy)}
                  className="h-6 rounded-md border border-[#24252b] bg-[#111216] px-2 text-[10px] text-[#8a8a92] opacity-0 transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-30 group-hover:opacity-100"
                >
                  {group.actionLabel}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CommitHistory({ history }: { history: GitHistoryState }) {
  const commits = history.status === 'ready' ? history.snapshot.commits : []

  return (
    <section className="mt-4 border-t border-[#1f2025] pt-3">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">History</div>
        <div className="shrink-0 text-[10px] text-[#5a5a63]">{commits.length ? `${commits.length} recent` : ''}</div>
      </div>
      {history.status === 'loading' ? (
        <div className="px-1 py-1.5 text-[11px] text-[#5a5a63]">Loading commits...</div>
      ) : history.status === 'error' ? (
        <div className="px-1 py-1.5 text-[11px] text-[#8a8a92]">{history.message}</div>
      ) : commits.length === 0 ? (
        <div className="px-1 py-1.5 text-[11px] text-[#5a5a63]">No commits yet</div>
      ) : (
        <div className="space-y-1">
          {commits.map((commit) => (
            <div
              key={commit.hash}
              className="group flex min-h-[40px] items-start gap-2 rounded-md px-2 py-1.5 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#ececee]"
              title={commit.subject}
            >
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full border border-[#3a3d49] bg-[#17181d]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[#d7d7dc] group-hover:text-[#ececee]">{commit.subject}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[#5a5a63]">
                  <span className="font-mono text-[#8a8a92]">{commit.shortHash}</span>
                  <span>{commit.date}</span>
                  <span className="min-w-0 truncate">{commit.author}</span>
                </div>
              </div>
              {commit.refs.length > 0 ? (
                <span className="mt-0.5 max-w-[76px] shrink-0 truncate rounded-full border border-[#24252b] bg-[#0d0e11] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[#8a8a92]">
                  {commit.refs[0].replace(/^HEAD -> /, '')}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
