import { useEffect, useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import type { ChangeFileStatus, ReviewChangeSet } from '../../../../shared/review'

// v1 placeholder for the review workspace surface. Reads the workspace's change
// set (materialized on disk by ingestion, MC-1676) and renders its title and a
// file/stat summary — the guided walkthrough body replaces this in MC-1680. All
// data is a projection of the validated change set; a read failure is shown
// explicitly, never rendered as an empty review.

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; changeset: ReviewChangeSet | null }

const STATUS_GLYPH: Record<ChangeFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

const DEPTH_LABEL: Record<'brief' | 'standard' | 'thorough', string> = {
  brief: 'Brief',
  standard: 'Standard',
  thorough: 'Thorough',
}

function sourceSummary(changeset: ReviewChangeSet): string {
  const { source } = changeset
  if (source.kind === 'pull-request') {
    return `${source.owner}/${source.repo} #${source.number}`
  }
  if (source.kind === 'branch') {
    return `${changeset.headRef ?? source.headRef} → ${changeset.baseRef}`
  }
  return source.label ?? 'Pasted patch'
}

export default function ReviewPanel({ workspaceId }: { workspaceId: string }) {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const guideConfig = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.reviewGuideConfig ?? null,
  )
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    if (!folderPath) {
      setState({ phase: 'error', message: 'This review workspace has no project folder.' })
      return
    }
    let cancelled = false
    setState({ phase: 'loading' })
    void window.api
      .reviewReadChangeset({ workspaceRoot: folderPath, workspaceId })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setState({ phase: 'ready', changeset: result.changeset })
        else setState({ phase: 'error', message: result.error })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [folderPath, workspaceId])

  const guideLine = useMemo(() => {
    if (!guideConfig) return null
    const parts = [guideConfig.engineCli, DEPTH_LABEL[guideConfig.depth]]
    parts.push(guideConfig.knowledgeGraph ? 'Knowledge graph on' : 'Knowledge graph off')
    return parts.join(' · ')
  }, [guideConfig])

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-6 py-5">
      {state.phase === 'loading' ? (
        <p className="text-[12.5px] text-[color:var(--text-muted)]">Loading the change set…</p>
      ) : state.phase === 'error' ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">Couldn’t open this review</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">{state.message}</p>
        </div>
      ) : state.changeset === null ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">No change set yet</h3>
          <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
            This review workspace has no change set on disk. Create a new review from a pull request, branch, or patch.
          </p>
        </div>
      ) : (
        <ChangeSetSummary changeset={state.changeset} guideLine={guideLine} />
      )}
    </div>
  )
}

function ChangeSetSummary({ changeset, guideLine }: { changeset: ReviewChangeSet; guideLine: string | null }) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
          {changeset.title}
        </h2>
        <p className="font-mono text-[12px] leading-5 text-[color:var(--text-muted)]">
          {sourceSummary(changeset)} · <span className="tabular-nums">{changeset.stats.files}</span> files ·{' '}
          <span className="tabular-nums">+{changeset.stats.additions}</span>{' '}
          <span className="tabular-nums">−{changeset.stats.deletions}</span>
        </p>
        {guideLine ? (
          <p className="text-[11.5px] leading-4 text-[color:var(--text-subtle)]">Guide · {guideLine}</p>
        ) : null}
      </header>

      <ul className="flex flex-col divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
        {changeset.files.map((file) => (
          <li key={file.path} className="flex items-center gap-3 py-1.5">
            <span
              className="w-3 shrink-0 text-center font-mono text-[11px] text-[color:var(--text-subtle)]"
              title={file.status}
              aria-label={file.status}
            >
              {STATUS_GLYPH[file.status]}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[color:var(--text-strong)]">
              {file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
            {file.binary ? (
              <span className="shrink-0 text-[11px] text-[color:var(--text-subtle)]">binary</span>
            ) : (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]">
                +{file.additions} −{file.deletions}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
