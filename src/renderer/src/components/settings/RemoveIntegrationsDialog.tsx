import React, { useEffect, useId, useMemo, useState } from 'react'

import {
  INTEGRATION_REMOVAL_GROUP_LABEL,
  INTEGRATION_REMOVAL_GROUP_ORDER,
  type IntegrationRemovalGroup,
  type IntegrationRemovalOptions,
  type IntegrationRemovalOutcome,
  type IntegrationRemovalPlan,
  type IntegrationRemovalReport,
  type IntegrationRemovalStatus,
} from '../../../../shared/integration-removal'
import { DefinitionList, DescribedCheckRow, DescribedCheckRowList, GroupHeader, InlineNotice, Spinner } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'

type Phase =
  | { kind: 'planning' }
  | { kind: 'plan'; plan: IntegrationRemovalPlan }
  | { kind: 'removing'; plan: IntegrationRemovalPlan }
  | { kind: 'done'; report: IntegrationRemovalReport }
  | { kind: 'error'; message: string }

/** Items by group, in the order the confirmation lists them; empty groups left out. */
export function groupRemovalItems<T extends { group: IntegrationRemovalGroup }>(
  items: readonly T[],
): Array<{ group: IntegrationRemovalGroup; items: T[] }> {
  return INTEGRATION_REMOVAL_GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0)
}

/** "3 removed · 1 skipped · 0 failed" */
export function removalSummaryLine(report: Pick<IntegrationRemovalReport, 'removed' | 'skipped' | 'failed'>): string {
  return `${report.removed} removed · ${report.skipped} skipped · ${report.failed} failed`
}

const STATUS_TITLE: Record<IntegrationRemovalStatus, string> = {
  failed: 'Could not be removed',
  skipped: 'Skipped',
  removed: 'Removed',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One collapsible run of entries: what each is, where it is, and (after removal) why it was not removed. */
function EntryGroup({
  title,
  count,
  entries,
}: {
  title: string
  count: string
  entries: Array<{ id: string; label: string; path: string; reason?: string }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const regionId = useId()
  return (
    <div>
      <GroupHeader title={title} count={count} expanded={expanded} onExpandedChange={setExpanded} controls={regionId} />
      <div id={regionId} hidden={!expanded} className="px-3 pb-2">
        <DefinitionList
          layout="stack"
          items={entries.map((entry) => ({
            id: `${regionId}-${entry.id}`,
            term: entry.reason ? `${entry.label} — ${entry.reason}` : entry.label,
            description: <span className="font-mono [overflow-wrap:anywhere]">{entry.path}</span>,
          }))}
        />
      </div>
    </div>
  )
}

/**
 * Settings ▸ General ▸ Remove integrations, and Machines' clean-up of one
 * distribution: what Studio wrote outside its own data, listed by where it
 * is, confirmed, removed, and accounted for — removed, skipped (already gone,
 * or no longer Studio's) or failed, each with its reason.
 */
export function RemoveIntegrationsDialog({
  open,
  onClose,
  scope,
  onQuit,
}: {
  open: boolean
  onClose: () => void
  /** Only one machine's entries (a WSL distribution); absent is everything. */
  scope?: { hostId: string; label: string }
  /** Offered once the removal is done: Studio writes what an agent needs again while it runs. */
  onQuit?: () => void
}): React.JSX.Element {
  const titleId = useId()
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' })
  const [removeWorktrees, setRemoveWorktrees] = useState(false)
  const [deleteAppData, setDeleteAppData] = useState(false)
  const scopeHostId = scope?.hostId

  useEffect(() => {
    if (!open) return
    let live = true
    setPhase({ kind: 'planning' })
    setRemoveWorktrees(false)
    setDeleteAppData(false)
    window.api
      .integrationsPlan(scopeHostId ? { hostId: scopeHostId } : {})
      .then((plan) => {
        if (live) setPhase({ kind: 'plan', plan })
      })
      .catch((error: unknown) => {
        if (live) setPhase({ kind: 'error', message: errorMessage(error) })
      })
    return () => {
      live = false
    }
  }, [open, scopeHostId])

  const groups = useMemo(
    () => (phase.kind === 'plan' || phase.kind === 'removing' ? groupRemovalItems(phase.plan.items) : []),
    [phase],
  )

  const remove = (plan: IntegrationRemovalPlan): void => {
    setPhase({ kind: 'removing', plan })
    const options: IntegrationRemovalOptions = {
      ...(scopeHostId ? { hostId: scopeHostId } : {}),
      ...(removeWorktrees ? { removeWorktrees: true } : {}),
      ...(deleteAppData ? { deleteAppData: true } : {}),
    }
    window.api
      .integrationsRemove(options)
      .then((report) => setPhase({ kind: 'done', report }))
      .catch((error: unknown) => setPhase({ kind: 'error', message: errorMessage(error) }))
  }

  const busy = phase.kind === 'removing'
  const plan = phase.kind === 'plan' || phase.kind === 'removing' ? phase.plan : null
  const nothingToRemove = plan !== null && plan.items.length === 0 && plan.appDataPaths.length === 0

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} labelledBy={titleId} size="standard">
      <ModalHeader
        title="Remove Studio’s integrations"
        subtitle={scope?.label}
        titleId={titleId}
        onClose={busy ? undefined : onClose}
      />
      <ModalBody>
        {phase.kind === 'planning' ? (
          <p role="status" className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
            <Spinner /> Finding what Studio wrote…
          </p>
        ) : null}

        {phase.kind === 'error' ? (
          <InlineNotice tone="error" title="The removal could not run." hint={phase.message} />
        ) : null}

        {plan && nothingToRemove ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">Studio has nothing to remove here.</p>
        ) : null}

        {plan && !nothingToRemove ? (
          <div className="space-y-3">
            <p className="text-body leading-5 text-[color:var(--text-default)]">
              Only what Studio wrote comes out: its blocks, keys and entries are removed from your files and everything
              around them stays as it is. Worktrees are only unlocked, unless you choose below to remove them.
            </p>
            {groups.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)]">
                {groups.map(({ group, items }) => (
                  <EntryGroup
                    key={group}
                    title={INTEGRATION_REMOVAL_GROUP_LABEL[group]}
                    count={String(items.length)}
                    entries={items}
                  />
                ))}
              </div>
            ) : null}
            {plan.lockedWorktrees.length > 0 || plan.appDataPaths.length > 0 ? (
              <DescribedCheckRowList ariaLabel="Also remove">
                {plan.lockedWorktrees.length > 0 ? (
                  <DescribedCheckRow
                    id="remove-integrations-worktrees"
                    title="Also remove the worktrees Studio locked"
                    description={`${plan.lockedWorktrees.length} agent worktree(s), removed with git worktree remove — their ignored files, like build output, go with them. One with uncommitted or untracked changes is kept, unlocked.`}
                    checked={removeWorktrees}
                    onChange={setRemoveWorktrees}
                    disabled={busy}
                  />
                ) : null}
                {plan.appDataPaths.length > 0 ? (
                  <DescribedCheckRow
                    id="remove-integrations-app-data"
                    title="Also delete Studio’s data"
                    description="Settings, logs and downloaded runtimes. Studio quits when the removal is done, and they are deleted once it has — unless something could not be removed, when they are kept so a second run can try again. Your repositories, your extensions and the agent CLIs you installed are kept."
                    checked={deleteAppData}
                    onChange={setDeleteAppData}
                    disabled={busy}
                  />
                ) : null}
              </DescribedCheckRowList>
            ) : null}
            <p className="text-meta leading-5 text-[color:var(--text-muted)]">
              While Studio runs it writes what an agent needs again, so do this just before you uninstall it.
            </p>
          </div>
        ) : null}

        {phase.kind === 'done' ? (
          <div className="space-y-3">
            {phase.report.failed > 0 ? (
              <InlineNotice
                tone="warn"
                title={removalSummaryLine(phase.report)}
                hint="What failed is still listed; running the removal again tries it again."
              />
            ) : (
              <p role="status" className="text-body leading-5 text-[color:var(--text-default)]">
                {removalSummaryLine(phase.report)}
                {phase.report.appDataScheduled ? '. Studio now quits, and its data is deleted once it has.' : ''}
              </p>
            )}
            {phase.report.outcomes.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)]">
                {(['failed', 'skipped', 'removed'] as const).map((status) => {
                  const outcomes = phase.report.outcomes.filter(
                    (outcome: IntegrationRemovalOutcome) => outcome.status === status,
                  )
                  return outcomes.length > 0 ? (
                    <EntryGroup
                      key={status}
                      title={STATUS_TITLE[status]}
                      count={String(outcomes.length)}
                      entries={outcomes}
                    />
                  ) : null
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {phase.kind === 'done' ? (
          <>
            <ModalButton onClick={onClose}>Close</ModalButton>
            {onQuit ? (
              <ModalButton variant="primary" onClick={onQuit}>
                Quit Studio
              </ModalButton>
            ) : null}
          </>
        ) : (
          <>
            <ModalButton onClick={onClose} disabled={busy}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="danger"
              disabled={phase.kind !== 'plan' || nothingToRemove}
              onClick={() => {
                if (phase.kind === 'plan') remove(phase.plan)
              }}
            >
              {busy ? 'Removing…' : 'Remove'}
            </ModalButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}
