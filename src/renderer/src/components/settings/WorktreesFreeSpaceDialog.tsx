import React, { useEffect, useId, useMemo, useState } from 'react'

import { DescribedCheckRow, DescribedCheckRowList } from '../ui'
import { DangerButton, GhostButton } from '../ui/Buttons'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal'
import {
  bytesOf,
  formatBytes,
  planFreeSpace,
  type WorktreeProjectView,
  type WorktreeRow,
} from './worktreesSettingsModel'

function names(rows: readonly WorktreeRow[]): string {
  const shown = rows.slice(0, 4).map((row) => `${row.name} (${formatBytes(row.bytes)})`)
  return rows.length > 4 ? `${shown.join(', ')} and ${rows.length - 4} more` : shown.join(', ')
}

/**
 * Free up space: the removals Settings ▸ Worktrees can make without asking
 * about each worktree, because none of them loses anything. Nothing in use or
 * holding uncommitted work is offered, branches are always kept, and a
 * worktree whose commits are not on the default branch is named but never
 * ticked: that one is removed from its own row, on purpose.
 */
export function FreeSpaceDialog({
  open,
  projects,
  onClose,
  onRun,
}: {
  open: boolean
  projects: readonly WorktreeProjectView[]
  onClose: () => void
  onRun: (plan: { remove: WorktreeRow[]; clear: WorktreeRow[] }) => void | Promise<void>
}): React.JSX.Element | null {
  const titleId = useId()
  const plan = useMemo(() => planFreeSpace(projects), [projects])
  const [extra, setExtra] = useState(true)
  const [merged, setMerged] = useState(true)
  const [clear, setClear] = useState(false)
  useEffect(() => {
    if (!open) return
    setExtra(plan.extraReady.length > 0)
    setMerged(plan.merged.length > 0)
    setClear(false)
  }, [open, plan])
  if (!open) return null

  const removing = [...(extra ? plan.extraReady : []), ...(merged ? plan.merged : [])]
  const bytes = bytesOf(removing)
  const nothing = removing.length === 0 && !(clear && plan.keptReady.length > 0)

  return (
    <Modal open onClose={onClose} labelledBy={titleId} size="standard">
      <ModalHeader
        title="Free up space"
        subtitle="Nothing in use or holding uncommitted work is touched. Branches are kept."
        titleId={titleId}
        onClose={onClose}
      />
      <ModalBody>
        <DescribedCheckRowList ariaLabel="What to remove">
          <DescribedCheckRow
            id={`${titleId}-extra`}
            title={`Remove ready worktrees beyond one per project · ${formatBytes(bytesOf(plan.extraReady))}`}
            description={
              plan.extraReady.length
                ? `${names(plan.extraReady)}. The most recently used one stays, so the next chat starts quickly.`
                : 'No project has more than one ready worktree.'
            }
            checked={extra && plan.extraReady.length > 0}
            disabled={plan.extraReady.length === 0}
            onChange={setExtra}
          />
          <DescribedCheckRow
            id={`${titleId}-merged`}
            title={`Remove worktrees whose branch is merged · ${formatBytes(bytesOf(plan.merged))}`}
            description={
              plan.merged.length
                ? `${names(plan.merged)}. Worktrees outside the pool with no changes, whose work is on the default branch.`
                : 'No worktree outside the pool is merged, clean and unused.'
            }
            checked={merged && plan.merged.length > 0}
            disabled={plan.merged.length === 0}
            onChange={setMerged}
          />
          <DescribedCheckRow
            id={`${titleId}-clear`}
            title="Clear ignored files in the ready worktrees kept"
            description={
              plan.keptReady.length
                ? `${names(plan.keptReady)}: installed dependencies and build output. The next agent in each runs the install again.`
                : 'No ready worktree is kept.'
            }
            checked={clear && plan.keptReady.length > 0}
            disabled={plan.keptReady.length === 0}
            onChange={setClear}
          />
          {plan.unmerged.length > 0 ? (
            <DescribedCheckRow
              id={`${titleId}-unmerged`}
              title={`Not merged, so not offered · ${formatBytes(bytesOf(plan.unmerged))}`}
              description={`${names(plan.unmerged)} hold commits the default branch lacks. Remove one from its own row if you mean to; its branch is kept.`}
              checked={false}
              disabled
              onChange={() => {}}
            />
          ) : null}
        </DescribedCheckRowList>
      </ModalBody>
      <ModalFooter>
        <span className="mr-auto text-meta text-[color:var(--text-muted)]">
          {bytes ? `Frees about ${formatBytes(bytes)}` : removing.length ? '' : 'Nothing to remove'}
          {clear && plan.keptReady.length ? `${bytes ? ', ' : 'Frees '}what installs took` : ''}
        </span>
        <GhostButton size="sm" onClick={onClose}>
          Cancel
        </GhostButton>
        <DangerButton
          size="sm"
          disabled={nothing}
          onClick={() => void onRun({ remove: removing, clear: clear ? plan.keptReady : [] })}
        >
          {bytes ? `Free ${formatBytes(bytes)}` : 'Free up space'}
        </DangerButton>
      </ModalFooter>
    </Modal>
  )
}
