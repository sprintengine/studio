import type { JSX } from 'react'

import type { AutomationsInstanceEntry } from '../../../../../../shared/automations/contracts'
import { Badge, DefinitionList, GhostButton, InlineNotice, PrimaryButton } from '../../../ui'
import { actionLabel, cadenceSummary } from '../../../panels/AutomationsPanel/automationsFormat'
import { approvalReviewCopy, approvalReviewFacts } from './approvalReview'
import { projectLabel } from './railState'

// The review an automation this machine did not write waits on. It leads the
// canvas, above the trigger / prompt facts it asks about, and says the things
// that decide how much an automation can do while nobody watches: which agent,
// whether it skips every approval prompt, and whether it works in its own
// worktree or straight in the user's checkout. The prompt itself is the canvas's
// next block, so it is read in the same place it always is rather than twice.
//
// Allow is the review's one call to action. "Allow all" appears only when the
// same project has more than one waiting — the case an upgrade produces, where
// every automation already on disk asks once — and the surface confirms it,
// because it approves files the person has not each opened.
export function AutomationApprovalReview({
  entry,
  waitingInProject,
  busy,
  cliLabel,
  onAllow,
  onAllowAll,
}: {
  entry: AutomationsInstanceEntry
  /** How many automations in this entry's project are waiting, this one included. */
  waitingInProject: number
  busy: boolean
  /** The display name of a CLI id; the id itself when the catalog does not know it. */
  cliLabel: (cli: string) => string
  onAllow: () => void
  onAllowAll: () => void
}): JSX.Element | null {
  const approval = entry.approval
  if (approval?.state !== 'needs-approval') return null
  const { definition } = entry
  const facts = approvalReviewFacts(definition)
  const copy = approvalReviewCopy(approval.reason)

  const items = [{ term: 'When', description: <Value text={cadenceSummary(definition.trigger)} /> }]
  items.push({ term: 'What runs', description: <Value text={actionLabel(definition.action.kind)} /> })
  if (facts.agentBacked) {
    const agent = facts.cli ? cliLabel(facts.cli) : 'The agent you last used'
    items.push({ term: 'Agent', description: <Value text={facts.model ? `${agent} · ${facts.model}` : agent} /> })
    items.push({
      term: 'Permission',
      description:
        facts.permission === 'bypass' ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone="warn">Bypass</Badge>
            <span>
              {facts.permissionIsDefault
                ? 'Skips every approval prompt — the default, because the file names no preset.'
                : 'Skips every approval prompt.'}{' '}
              The agent edits files and runs commands without asking.
            </span>
          </span>
        ) : facts.permission === 'auto' ? (
          <Value text="Edits files in the workspace without asking; asks before commands and anything outside it." />
        ) : facts.permission === 'manual' ? (
          <Value text="Asks before every edit, command and outside call." />
        ) : facts.permission === 'none' ? (
          <Value text="Asks as its CLI is configured to — no bypass flag." />
        ) : (
          <Value text="A preset this app does not recognise — the run will refuse to start." />
        ),
    })
    items.push({
      term: 'Where',
      description: facts.runsInWorktree ? (
        <Value text="Its own worktree, with a pull request for you to review." />
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge tone="warn">Your checkout</Badge>
          <span>No worktree, no branch, no pull request — its changes land in your working copy.</span>
        </span>
      ),
    })
  }
  if (facts.folderPath) items.push({ term: 'Folder', description: <Value text={facts.folderPath} /> })

  return (
    <InlineNotice
      tone="warn"
      title={copy.title}
      hint={copy.hint}
      action={
        <>
          <PrimaryButton size="xs" onClick={onAllow} disabled={busy}>
            Allow
          </PrimaryButton>
          {waitingInProject > 1 ? (
            <GhostButton size="xs" onClick={onAllowAll} disabled={busy}>
              {`Allow all ${waitingInProject} in ${projectLabel(entry.workspaceRoot)}`}
            </GhostButton>
          ) : null}
        </>
      }
    >
      <DefinitionList className="py-1" items={items} />
      {facts.rawConfig ? (
        <div className="flex flex-col gap-1 pt-1.5">
          <span className="text-meta text-[color:var(--text-subtle)]">Settings</span>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2 font-mono text-meta leading-5 text-[color:var(--text-default)]">
            {facts.rawConfig}
          </pre>
        </div>
      ) : null}
    </InlineNotice>
  )
}

// Wrapped, never clipped: a fact someone is being asked to approve is read in
// full, not behind a hover.
function Value({ text }: { text: string }): JSX.Element {
  return <span className="block min-w-0 [overflow-wrap:anywhere]">{text}</span>
}
