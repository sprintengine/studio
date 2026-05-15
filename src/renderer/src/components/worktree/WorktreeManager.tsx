import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { WorktreeEntry as StoredWorktreeEntry } from '../../types/workspace'
import { focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { Select, StatusDot, type SelectItem, type Tone } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'

type WorktreeMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
}

type WorktreeRow = {
  id: string
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  missing: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
  dirtyCount: number | null
  ownerAgentId: string | null
  storedEntry: StoredWorktreeEntry | null
  listedEntry: GitWorktreeEntry | null
}

type Props = {
  workspaceId: string
  repoRoot: string
  currentBranch: string | null
  branchOptions: string[]
  mode?: 'section' | 'tab'
  onChanged: () => Promise<void>
}

const terminalCols = 100
const terminalRows = 30

function trimPath(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, '')
}

function samePath(a: string, b: string): boolean {
  return trimPath(a).toLowerCase() === trimPath(b).toLowerCase()
}

function basename(pathValue: string): string {
  const parts = trimPath(pathValue).split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? pathValue
}

function parentPath(pathValue: string): string {
  const trimmed = trimPath(pathValue)
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return trimmed
  return trimmed.slice(0, index)
}

function pathJoin(basePath: string, ...segments: string[]): string {
  const separator = basePath.includes('\\') ? '\\' : '/'
  return [trimPath(basePath), ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ''))]
    .filter(Boolean)
    .join(separator)
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

function worktreeIdFromPath(pathValue: string): string {
  return `worktree-${slugify(pathValue).replace(/[\\/.:]+/g, '-')}`
}

function defaultContainerPath(repoRoot: string): string {
  return pathJoin(parentPath(repoRoot), '.multicode-worktrees', basename(repoRoot))
}

function branchLabel(row: WorktreeRow): string {
  if (row.branch) return row.branch
  if (row.head) return row.head.slice(0, 8)
  return 'detached'
}

function rowStatusLabel(row: WorktreeRow): string {
  if (row.missing) return 'Missing'
  if (row.prunable) return 'Prunable'
  if (row.locked) return 'Locked'
  if (row.dirtyCount && row.dirtyCount > 0) return `Dirty ${row.dirtyCount}`
  return 'Clean'
}

function rowStatusTone(row: WorktreeRow): Tone {
  if (row.missing || row.prunable) return 'error'
  if (row.dirtyCount && row.dirtyCount > 0) return 'warn'
  if (row.locked) return 'warn'
  return 'good'
}

function messageFromResult<T>(result: GitWorktreeOperationResult<T>, success: string): WorktreeMessage {
  if (result.ok) return { tone: 'success', text: result.message ?? success }
  return { tone: 'error', text: result.message }
}

export default function WorktreeManager({
  workspaceId,
  repoRoot,
  currentBranch,
  branchOptions,
  mode = 'section',
  onChanged,
}: Props) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId) ?? null)
  const setWorkspaceWorktreeState = useWorkspaceStore((state) => state.setWorkspaceWorktreeState)
  const upsertWorktreeEntry = useWorkspaceStore((state) => state.upsertWorktreeEntry)
  const removeWorktreeEntry = useWorkspaceStore((state) => state.removeWorktreeEntry)
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace)
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace)
  const dialog = useConfirmDialog()
  const [open, setOpen] = useState(true)
  const [rows, setRows] = useState<WorktreeRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<WorktreeMessage | null>(null)
  const [worktreeName, setWorktreeName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [baseRef, setBaseRef] = useState(currentBranch ?? 'HEAD')
  const [copyIncludedFiles, setCopyIncludedFiles] = useState(true)

  const storedEntries = useMemo(
    () => Object.values(workspace?.worktreeState.entries ?? {}),
    [workspace?.worktreeState.entries]
  )
  const containerPath = workspace?.worktreeState.containerPath ?? defaultContainerPath(repoRoot)
  const template = useMemo(
    () => LAYOUT_TEMPLATES.find((item) => item.id === 'solo-dev') ?? LAYOUT_TEMPLATES[0],
    []
  )

  useEffect(() => {
    if (!baseRef || baseRef === 'HEAD') setBaseRef(currentBranch ?? 'HEAD')
  }, [baseRef, currentBranch])

  useEffect(() => {
    const slug = slugify(worktreeName)
    if (!slug) {
      setBranchName('')
      return
    }
    setBranchName(`multicode/${slug}`)
  }, [worktreeName])

  const refreshWorktrees = useCallback(async () => {
    if (typeof window.api.listGitWorktrees !== 'function') return
    setLoading(true)
    try {
      const result = await window.api.listGitWorktrees(repoRoot)
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return
      }

      const listedRows = await Promise.all(
        result.data.worktrees.map(async (worktree): Promise<WorktreeRow> => {
          const exists = await window.api.pathExists(worktree.path).catch(() => false)
          let dirtyCount: number | null = null
          if (exists && !worktree.bare) {
            try {
              const status = await window.api.getGitStatus(worktree.path)
              dirtyCount = Object.keys(status.files).length
            } catch {
              dirtyCount = null
            }
          }

          const storedEntry = storedEntries.find((entry) => samePath(entry.path, worktree.path)) ?? null
          return {
            id: storedEntry?.id ?? worktreeIdFromPath(worktree.path),
            path: worktree.path,
            branch: worktree.branch,
            head: worktree.head,
            isMain: samePath(worktree.path, repoRoot),
            missing: !exists,
            locked: worktree.locked,
            lockedReason: worktree.lockedReason,
            prunable: worktree.prunable,
            prunableReason: worktree.prunableReason,
            dirtyCount,
            ownerAgentId: storedEntry?.ownerAgentId ?? null,
            storedEntry,
            listedEntry: worktree,
          }
        })
      )

      const listedPaths = new Set(listedRows.map((row) => trimPath(row.path).toLowerCase()))
      const orphanedRows = (await Promise.all(
        storedEntries
          .filter((entry) => !listedPaths.has(trimPath(entry.path).toLowerCase()))
          .map(async (entry): Promise<WorktreeRow | null> => {
            const exists = await window.api.pathExists(entry.path).catch(() => false)
            if (!exists) {
              removeWorktreeEntry(workspaceId, entry.id)
              return null
            }

            return {
            id: entry.id,
            path: entry.path,
            branch: entry.branch,
            head: null,
            isMain: samePath(entry.path, repoRoot),
            missing: true,
            locked: false,
            lockedReason: null,
            prunable: false,
            prunableReason: 'Stored worktree is not listed by Git.',
            dirtyCount: null,
            ownerAgentId: entry.ownerAgentId,
            storedEntry: entry,
            listedEntry: null,
            }
          })
      )).filter((row): row is WorktreeRow => Boolean(row))

      setRows([...listedRows, ...orphanedRows].sort((a, b) => Number(b.isMain) - Number(a.isMain) || branchLabel(a).localeCompare(branchLabel(b))))
    } finally {
      setLoading(false)
    }
  }, [removeWorktreeEntry, repoRoot, storedEntries, workspaceId])

  useEffect(() => {
    void refreshWorktrees()
  }, [refreshWorktrees])

  const runWorktreeAction = async (label: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(label)
    setMessage({ tone: 'neutral', text: `${label}...` })
    try {
      await action()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const handleCreate = async () => {
    const slug = slugify(worktreeName)
    const branch = branchName.trim()
    if (!slug || !branch) {
      setMessage({ tone: 'error', text: 'Enter a worktree name and branch.' })
      return
    }

    await runWorktreeAction('Creating worktree', async () => {
      const destinationPath = pathJoin(containerPath, slug)
      setWorkspaceWorktreeState(workspaceId, { containerPath })
      const result = await window.api.createGitWorktree({
        repoRoot,
        containerPath,
        destinationPath,
        branchName: branch,
        baseRef: baseRef.trim() || 'HEAD',
        copyIncludedFiles,
      })
      setMessage(messageFromResult(result, 'Created worktree.'))
      if (!result.ok) return

      const now = Date.now()
      upsertWorktreeEntry(workspaceId, {
        id: worktreeIdFromPath(result.data.path),
        path: result.data.path,
        branch: result.data.branch ?? branch,
        ownerAgentId: null,
        status: 'available',
        createdAt: now,
        updatedAt: now,
      })
      setWorktreeName('')
      setBranchName('')
      await refreshWorktrees()
      await onChanged()
    })
  }

  const handlePrune = async () => {
    await runWorktreeAction('Pruning stale worktrees', async () => {
      const result = await window.api.pruneGitWorktrees(repoRoot)
      setMessage(messageFromResult(result, 'Pruned stale worktree metadata.'))
      if (result.ok) {
        await refreshWorktrees()
        await onChanged()
      }
    })
  }

  const handleReveal = async (row: WorktreeRow) => {
    await runWorktreeAction('Revealing worktree', async () => {
      await window.api.showItemInFolder(row.path)
      setMessage({ tone: 'success', text: 'Revealed worktree path.' })
    })
  }

  const handleOpenWorkspace = (row: WorktreeRow) => {
    const workspaceName = `Worktree: ${branchLabel(row)}`
    const nextWorkspaceId = addWorkspace(template, { name: workspaceName, folderPath: row.path })
    setActiveWorkspace(nextWorkspaceId)
  }

  const handleOpenTerminal = async (row: WorktreeRow) => {
    await runWorktreeAction('Opening terminal', async () => {
      const terminalId = `worktree-${row.id}`
      const result = await window.api.terminalSpawn(
        `terminal-${terminalId}`,
        terminalCols,
        terminalRows,
        row.path,
        false,
        workspace?.sprintEngineContext?.statePath,
        undefined,
        undefined,
        undefined,
        true,
        {
          kind: 'terminal',
          workspaceId,
          terminalId,
        }
      )
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return
      }
      focusOrAddTerminalTab(workspaceId, terminalId, `WT ${branchLabel(row)}`)
      setMessage({ tone: 'success', text: 'Opened terminal in worktree.' })
    })
  }

  const handleRemove = async (row: WorktreeRow) => {
    const force = Boolean(row.dirtyCount && row.dirtyCount > 0)
    if (force) {
      const confirmation = await dialog.prompt({
        title: 'Force remove worktree?',
        body: (
          <>
            Worktree <span className="font-mono">{branchLabel(row)}</span> has uncommitted changes. Removing it will discard those changes. Type <span className="font-mono">remove</span> to confirm.
          </>
        ),
        inputLabel: 'Type "remove" to confirm',
        placeholder: 'remove',
        required: true,
        confirmLabel: 'Force remove',
        tone: 'danger',
        validate: (value) => (value.trim() === 'remove' ? null : 'Type "remove" exactly to confirm'),
      })
      if (confirmation === null || confirmation.trim() !== 'remove') {
        setMessage({ tone: 'neutral', text: 'Remove cancelled.' })
        return
      }
    }

    await runWorktreeAction('Removing worktree', async () => {
      const result = await window.api.removeGitWorktree({ repoRoot, path: row.path, force })
      setMessage(messageFromResult(result, 'Removed worktree.'))
      if (!result.ok) return
      if (row.storedEntry) removeWorktreeEntry(workspaceId, row.storedEntry.id)
      await refreshWorktrees()
      await onChanged()
    })
  }

  const formDisabled = Boolean(busy) || loading
  const contentOpen = mode === 'tab' || open
  const sectionClassName = mode === 'tab' ? 'min-h-0' : 'mb-5 border-b border-[color:var(--border-subtle)] pb-4'

  return (
    <section className={sectionClassName}>
      <div className="mb-2 flex h-7 items-center justify-between gap-2">
        {mode === 'tab' ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Worktrees</span>
            <span className="text-[10px] text-[color:var(--text-subtle)]">{rows.length}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="group flex min-w-0 items-center gap-1.5 rounded-md pr-2 text-left focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)]"
            aria-expanded={open}
          >
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className={`icon-xs shrink-0 text-[color:var(--text-subtle)] transition-transform group-hover:text-[color:var(--text-default)] ${open ? 'rotate-90' : ''}`}
              fill="none"
            >
              <path d="M4.25 2.5 7.75 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Worktrees</span>
            <span className="text-[10px] text-[color:var(--text-subtle)]">{rows.length}</span>
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void refreshWorktrees()}
            disabled={formDisabled}
            className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-35"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handlePrune()}
            disabled={formDisabled}
            className="h-6 rounded-md px-2 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus:ring-1 focus:ring-[color:var(--border-default)] disabled:opacity-35"
          >
            Prune
          </button>
        </div>
      </div>

      {contentOpen ? (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(80px,0.6fr)_auto]">
            <input
              value={worktreeName}
              onChange={(event) => setWorktreeName(event.target.value)}
              disabled={formDisabled}
              placeholder="worktree name"
              className="h-8 min-w-0 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-2 text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--border-strong)] disabled:opacity-50"
            />
            <input
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              disabled={formDisabled}
              placeholder="branch"
              className="h-8 min-w-0 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] px-2 font-mono text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--border-strong)] disabled:opacity-50"
            />
            <Select<string>
              ariaLabel="Worktree base ref"
              items={[
                { value: 'HEAD', label: 'HEAD' },
                ...branchOptions.map((branch): SelectItem<string> => ({ value: branch, label: branch })),
              ]}
              value={baseRef}
              onChange={setBaseRef}
              disabled={formDisabled}
              className="min-w-0"
            />
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={formDisabled || !worktreeName.trim() || !branchName.trim()}
              className="h-8 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--text-strong)] px-3 text-[11px] font-semibold text-[color:var(--bg-surface-raised)] transition-colors hover:bg-white focus:outline-none focus:ring-1 focus:ring-[color:var(--text-muted)] disabled:border-[color:var(--border-subtle)] disabled:bg-[color:var(--bg-hover)] disabled:text-[color:var(--text-disabled)]"
            >
              Create
            </button>
          </div>

          <label className="mb-3 flex w-fit items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
            <input
              type="checkbox"
              checked={copyIncludedFiles}
              onChange={(event) => setCopyIncludedFiles(event.target.checked)}
              disabled={formDisabled}
              className="h-3.5 w-3.5 accent-[color:var(--accent-primary)]"
            />
            Copy .worktreeinclude files
          </label>

          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[minmax(130px,0.8fr)_minmax(180px,1.4fr)_90px_90px_220px] gap-2 border-b border-[color:var(--border-subtle)] px-2 pb-1 text-[11px] font-medium text-[color:var(--text-muted)]">
                <span>Branch</span>
                <span>Path</span>
                <span>Status</span>
                <span>Owner</span>
                <span className="text-right">Actions</span>
              </div>
              {loading ? (
                <div className="px-2 py-3 text-[11px] text-[color:var(--text-subtle)]">Loading worktrees...</div>
              ) : rows.length === 0 ? (
                <div className="px-2 py-3 text-[11px] text-[color:var(--text-subtle)]">No worktrees reported by Git.</div>
              ) : (
                rows.map((row) => {
                  const ownerName = row.ownerAgentId ? workspace?.agents[row.ownerAgentId]?.name ?? row.ownerAgentId : '-'
                  const canUsePath = !row.missing && Boolean(row.listedEntry)
                  const canRemove = !row.isMain && Boolean(row.listedEntry) && !row.locked
                  return (
                    <div
                      key={`${row.id}:${row.path}`}
                      className="grid min-h-[34px] grid-cols-[minmax(130px,0.8fr)_minmax(180px,1.4fr)_90px_90px_220px] items-center gap-2 border-b border-[color:var(--bg-hover)] px-2 py-1.5 text-[12px] text-[color:var(--text-muted)]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[color:var(--text-default)]" title={branchLabel(row)}>
                          {branchLabel(row)}
                        </div>
                        {row.isMain ? <div className="text-[10px] text-[color:var(--text-subtle)]">main checkout</div> : null}
                      </div>
                      <div className="truncate font-mono text-[11px] text-[color:var(--text-subtle)]" title={row.path}>
                        {row.path}
                      </div>
                      <div className="min-w-0">
                        <span
                          className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-default)]"
                          title={row.lockedReason ?? row.prunableReason ?? undefined}
                        >
                          <StatusDot tone={rowStatusTone(row)} label={rowStatusLabel(row)} />
                          {rowStatusLabel(row)}
                        </span>
                      </div>
                      <div className="truncate text-[11px] text-[color:var(--text-subtle)]" title={ownerName}>
                        {ownerName}
                      </div>
                      <div className="flex justify-end gap-1">
                        <WorktreeAction label="Reveal" disabled={formDisabled || !canUsePath} onClick={() => void handleReveal(row)} />
                        <WorktreeAction label="Terminal" disabled={formDisabled || !canUsePath} onClick={() => void handleOpenTerminal(row)} />
                        <WorktreeAction label="Workspace" disabled={formDisabled || !canUsePath} onClick={() => handleOpenWorkspace(row)} />
                        <WorktreeAction danger label="Remove" disabled={formDisabled || !canRemove} onClick={() => void handleRemove(row)} />
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {message ? (
            <div
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={`mt-2 rounded-md px-2 py-1.5 text-[11px] [overflow-wrap:anywhere] ${
                message.tone === 'error'
                  ? 'border border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
                  : message.tone === 'success'
                    ? 'text-[color:var(--text-muted)]'
                    : 'bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]'
              }`}
            >
              {message.text}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function WorktreeAction({
  label,
  danger,
  disabled,
  onClick,
}: {
  label: string
  danger?: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-6 rounded-md px-2 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-1 disabled:cursor-default disabled:opacity-30 ${
        danger
          ? 'text-[color:var(--tone-error)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] focus:ring-[color:var(--tone-error)]'
          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:ring-[color:var(--border-default)]'
      }`}
    >
      {label}
    </button>
  )
}
