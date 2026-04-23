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
  entries: GitStatusEntry[]
}

function statusTone(status: GitFileStatus): { label: string; className: string } {
  switch (status) {
    case 'new':
      return { label: 'A', className: 'border-[#2e6f45] bg-[#14301e] text-[#43d17a]' }
    case 'modified':
      return { label: 'M', className: 'border-[#725327] bg-[#302313] text-[#f2a84b]' }
    case 'deleted':
      return { label: 'D', className: 'border-[#713036] bg-[#311417] text-[#ff5a5f]' }
    case 'renamed':
      return { label: 'R', className: 'border-[#725327] bg-[#302313] text-[#f2a84b]' }
    case 'conflicted':
      return { label: '!', className: 'border-[#713036] bg-[#311417] text-[#ff5a5f]' }
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

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshBranches()])
  }, [refresh, refreshBranches])

  useEffect(() => {
    void refreshBranches()
  }, [refreshBranches])

  const stagedEntries = useMemo(
    () => sortedEntries(Object.values(status?.files ?? {}).filter((entry) => entry.staged)),
    [status]
  )
  const unstagedEntries = useMemo(
    () => sortedEntries(Object.values(status?.files ?? {}).filter((entry) => entry.unstaged)),
    [status]
  )
  const allEntries = useMemo(() => sortedEntries(Object.values(status?.files ?? {})), [status])

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
      <div className="border-b border-[#1f2025] bg-[#111216] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">Git</div>
            <div className="truncate font-mono text-[11px] text-[#9a9aa2]">{branches?.current ?? 'detached'}</div>
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={Boolean(busy)}
            className="h-7 rounded-md border border-[#24252b] bg-[#15161a] px-2 text-[10px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <select
            value={branches?.current ?? ''}
            onChange={(event) => void handleSwitchBranch(event.target.value)}
            disabled={Boolean(busy)}
            className="h-8 min-w-0 rounded-md border border-[#24252b] bg-[#090a0c] px-2 text-[12px] text-[#ececee] outline-none transition-colors focus:border-[#303139] disabled:opacity-50"
          >
            {(branches?.branches ?? []).map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}{branch.upstream ? ` -> ${branch.upstream}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handlePush()}
            disabled={Boolean(busy)}
            className="h-8 rounded-md border border-[#2e6f45] bg-[#14301e] px-3 text-[11px] font-semibold text-[#43d17a] transition-colors hover:bg-[#193b26] disabled:opacity-50"
          >
            Push
          </button>
        </div>

        {(branches?.ahead || branches?.behind) ? (
          <div className="mt-2 flex gap-2 text-[10px] text-[#8a8a92]">
            <span>Ahead {branches.ahead}</span>
            <span>Behind {branches.behind}</span>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {allEntries.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-[#5a5a63]">Working tree clean</div>
        ) : (
          groups.map((group) => (
            <ChangeGroup key={group.title} group={group} busy={busy} />
          ))
        )}
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
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={Boolean(busy) || stagedEntries.length === 0 || !commitMessage.trim()}
            className="h-8 rounded-md border border-[#2d5f70] bg-[#112a33] px-3 text-[11px] font-semibold text-[#7bd7ea] transition-colors hover:bg-[#163440] disabled:opacity-40"
          >
            Commit
          </button>
        </div>
        {message ? (
          <div
            className={`mt-2 rounded-md border px-2.5 py-2 text-[11px] ${
              message.tone === 'error'
                ? 'border-[#713036] bg-[#311417] text-[#ff8a8e]'
                : message.tone === 'success'
                  ? 'border-[#2e6f45] bg-[#14301e] text-[#6ee79a]'
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
      <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">
        {group.title}
      </div>
      {group.entries.length === 0 ? (
        <div className="px-1 py-1.5 text-[11px] text-[#5a5a63]">{group.empty}</div>
      ) : (
        <div className="space-y-1">
          {group.entries.map((entry) => {
            const tone = statusTone(entry.status)
            return (
              <div
                key={`${group.title}:${entry.path}`}
                className="group flex min-h-[34px] items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-[#d7d7dc] transition-colors hover:bg-[#15161a]"
              >
                <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[10px] font-bold ${tone.className}`}>
                  {tone.label}
                </span>
                <span className={`min-w-0 flex-1 truncate font-mono ${entry.status === 'deleted' ? 'text-[#ff5a5f] line-through decoration-[#ff5a5f]/80' : ''}`}>
                  {entry.relativePath}
                </span>
                <button
                  type="button"
                  onClick={() => void group.action(entry.path)}
                  disabled={Boolean(busy)}
                  className="h-6 rounded border border-[#24252b] bg-[#111216] px-2 text-[10px] text-[#8a8a92] opacity-0 transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] disabled:opacity-30 group-hover:opacity-100"
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
