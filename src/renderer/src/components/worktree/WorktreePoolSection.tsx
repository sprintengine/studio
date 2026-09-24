import React, { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type {
  WorktreePoolActionInput,
  WorktreePoolSlotView,
  WorktreePoolSnapshot,
} from '../../../../shared/electron-api'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, InlineNotice, LifecycleGlyph, OverflowMenu } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { poolSummary, slotGlyph, slotMeta } from './worktreePoolView'

/**
 * The Worktree manager's Pool section: the repository's warm worktrees, the
 * ones leased to agents, and — the reason the section exists — the ones held
 * because an agent left work in them. A held slot is never reset by the pool;
 * the actions here are the only way it changes: Commit or Stash keep the work
 * (on the agent's branch, or in the stash), Discard throws it away after a
 * typed confirmation, and Keep turns the slot into an ordinary worktree.
 *
 * Nothing renders until the repository has a pool, which it gets the first time
 * an agent asks it for a worktree (or from "Warm up").
 */

type Props = {
  repoRoot: string
  /** The pool as main last described it (useWorktreePool); null while there is none. */
  snapshot: WorktreePoolSnapshot | null
  reload: () => Promise<void>
  busy: boolean
  onChanged: () => Promise<void>
}

export default function WorktreePoolSection({ repoRoot, snapshot, reload, busy, onChanged }: Props) {
  const dialog = useConfirmDialog()
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'neutral' | 'error'; text: string } | null>(null)
  const agentNames = useWorkspaceStore(
    useShallow((state) => {
      const names: Record<string, string> = {}
      for (const workspace of state.workspaces) {
        for (const [agentId, agent] of Object.entries(workspace.agents ?? {})) names[agentId] = agent.name
      }
      return names
    }),
  )

  if (typeof window.api.worktreePoolAction !== 'function') return null

  const run = async (label: string, input: WorktreePoolActionInput): Promise<void> => {
    if (pending) return
    setPending(label)
    setMessage(null)
    try {
      const result = await window.api.worktreePoolAction(input)
      setMessage(
        result.ok
          ? result.message
            ? { tone: 'neutral', text: result.message }
            : null
          : {
              tone: 'error',
              text: result.message,
            },
      )
      await reload()
      await onChanged()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(null)
    }
  }

  const commit = async (slot: WorktreePoolSlotView): Promise<void> => {
    const text = await dialog.prompt({
      title: 'Commit the held changes?',
      body: (
        <>
          Everything in <span className="font-mono">{slot.id}</span>, untracked files included, is committed on{' '}
          <span className="font-mono">{slot.held?.branch ?? 'a new branch'}</span>. The worktree then goes back to the
          pool.
        </>
      ),
      inputLabel: 'Commit message',
      initialValue: 'Work left in a pooled worktree',
      required: true,
      confirmLabel: 'Commit',
    })
    if (text === null) return
    await run('Committing', { kind: 'held', repoRoot, slotId: slot.id, action: 'commit', message: text })
  }

  const discard = async (slot: WorktreePoolSlotView): Promise<void> => {
    const typed = await dialog.prompt({
      title: 'Discard the held changes?',
      body: (
        <>
          The uncommitted changes in <span className="font-mono">{slot.id}</span> are deleted and cannot be recovered.
          Commits already on <span className="font-mono">{slot.held?.branch ?? 'its branch'}</span> are kept. Type{' '}
          <span className="font-mono">discard</span> to confirm.
        </>
      ),
      inputLabel: 'Type "discard" to confirm',
      placeholder: 'discard',
      required: true,
      confirmLabel: 'Discard changes',
      tone: 'danger',
      validate: (value) => (value.trim() === 'discard' ? null : 'Type "discard" exactly to confirm'),
    })
    if (typed === null || typed.trim() !== 'discard') return
    await run('Discarding', { kind: 'held', repoRoot, slotId: slot.id, action: 'discard' })
  }

  const keep = async (slot: WorktreePoolSlotView): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: 'Keep this worktree?',
      body: (
        <>
          <span className="font-mono">{slot.id}</span> leaves the pool as it is, changes and all, and becomes an
          ordinary worktree you manage above. The pool makes a new slot in its place.
        </>
      ),
      confirmLabel: 'Keep',
    })
    if (!confirmed) return
    await run('Keeping', { kind: 'held', repoRoot, slotId: slot.id, action: 'keep' })
  }

  const slotActions = (slot: WorktreePoolSlotView) => {
    const disabled = busy || Boolean(pending)
    const reveal = {
      id: 'reveal',
      label: 'Reveal in file manager',
      onSelect: () => void window.api.showItemInFolder(slot.path),
    }
    if (slot.state === 'held') {
      return [
        { id: 'commit', label: 'Commit…', onSelect: () => void commit(slot), disabled },
        {
          id: 'stash',
          label: 'Stash',
          onSelect: () => void run('Stashing', { kind: 'held', repoRoot, slotId: slot.id, action: 'stash' }),
          disabled,
        },
        { id: 'keep', label: 'Keep as a worktree…', onSelect: () => void keep(slot), disabled },
        {
          id: 'recheck',
          label: 'Check again',
          onSelect: () => void run('Checking', { kind: 'refresh', repoRoot, slotId: slot.id }),
          disabled,
        },
        reveal,
        { kind: 'separator' as const, id: 'sep' },
        { id: 'discard', label: 'Discard changes…', destructive: true, onSelect: () => void discard(slot), disabled },
      ]
    }
    if (slot.state === 'warm') {
      return [
        {
          id: 'refresh',
          label: 'Refresh now',
          onSelect: () => void run('Refreshing', { kind: 'refresh', repoRoot, slotId: slot.id }),
          disabled,
        },
        reveal,
        { kind: 'separator' as const, id: 'sep' },
        {
          id: 'evict',
          label: 'Remove from pool',
          destructive: true,
          onSelect: () => void run('Removing', { kind: 'evict', repoRoot, slotId: slot.id }),
          disabled,
        },
      ]
    }
    return [reveal]
  }

  if (!snapshot) {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 px-1">
        <span className="text-micro text-[color:var(--text-subtle)]">
          No worktree pool yet. One starts the first time an agent asks for a worktree.
        </span>
        <GhostButton
          size="xs"
          disabled={busy || Boolean(pending)}
          onClick={() => void run('Warming up', { kind: 'warm-up', repoRoot })}
        >
          Warm up
        </GhostButton>
      </div>
    )
  }

  const now = Date.now()
  return (
    <section className="mt-4" aria-label="Worktree pool">
      <div className="mb-1 flex h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-meta font-semibold text-[color:var(--text-strong)]">Pool</span>
          <span className="truncate text-micro text-[color:var(--text-subtle)]">{poolSummary(snapshot)}</span>
        </div>
        <OverflowMenu
          ariaLabel="Worktree pool actions"
          items={[
            {
              id: 'warm',
              label: 'Warm up now',
              onSelect: () => void run('Warming up', { kind: 'warm-up', repoRoot }),
              disabled: busy || Boolean(pending) || snapshot.disabled,
            },
            {
              id: 'toggle',
              label: snapshot.disabled ? 'Turn pool on for this repository' : 'Turn pool off for this repository',
              onSelect: () =>
                void run(snapshot.disabled ? 'Turning on' : 'Turning off', {
                  kind: 'set-disabled',
                  repoRoot,
                  disabled: !snapshot.disabled,
                }),
              disabled: busy || Boolean(pending),
            },
          ]}
        />
      </div>
      {snapshot.slots.length === 0 ? (
        <p className="px-1 text-micro text-[color:var(--text-subtle)]">No slots.</p>
      ) : (
        <ul role="list" className="-mx-1 space-y-0.5">
          {snapshot.slots.map((slot) => {
            const glyph = slotGlyph(slot)
            const owner = slot.lease?.owner.agentId ? (agentNames[slot.lease.owner.agentId] ?? null) : null
            const meta = slotMeta(slot, now, owner)
            const detail = slot.held?.detail ?? slot.error ?? undefined
            return (
              <li
                key={slot.id}
                className="group/wt flex min-h-[36px] items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[color:var(--bg-hover)]"
              >
                <span className="flex w-4 shrink-0 items-center justify-center self-start pt-1" title={detail}>
                  {glyph ? <LifecycleGlyph state={glyph.state} live={glyph.live} label={glyph.label} /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-meta text-[color:var(--text-default)]" title={slot.path}>
                    {slot.id}
                  </div>
                  <div className="truncate text-micro text-[color:var(--text-subtle)]" title={detail ?? meta}>
                    {meta}
                  </div>
                </div>
                <span className="shrink-0 opacity-60 transition-opacity group-hover/wt:opacity-100 focus-within:opacity-100">
                  <OverflowMenu ariaLabel={`Actions for pool slot ${slot.id}`} items={slotActions(slot)} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {pending ? (
        <p role="status" className="mt-2 px-1 text-meta text-[color:var(--text-muted)]">
          {pending}…
        </p>
      ) : message ? (
        message.tone === 'error' ? (
          <InlineNotice tone="error" className="mt-2 [overflow-wrap:anywhere]">
            {message.text}
          </InlineNotice>
        ) : (
          <p role="status" className="mt-2 px-1 text-meta text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
            {message.text}
          </p>
        )
      ) : null}
    </section>
  )
}
