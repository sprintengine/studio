import { useMemo, type ReactNode } from 'react'
import { DefinitionList, IconButton, InboxRow, Section, StatusDot, type DefinitionItem } from '../../ui'
import type { MultiloopArtifact, MultiloopDecision, MultiloopMilestone, MultiloopTask } from '../../../types/workspace'
import { formatDate, isModernVerdict, taskStatusLabels, taskStatusTone, verdictTitle, verdictTone } from './helpers'

// ===========================================================================
// REASSESSMENT COLUMN — loop-closing context: verdicts, recommendation,
// learned facts, decisions, evidence, artifacts, optional task detail.
// ===========================================================================

export function ReassessmentColumn({
  milestone,
  iteration,
  decisions,
  evidenceTasks,
  artifacts,
  selectedTask,
  onClearTaskSelection,
}: {
  milestone: MultiloopMilestone | null
  iteration: number
  decisions: MultiloopDecision[]
  evidenceTasks: MultiloopTask[]
  artifacts: MultiloopArtifact[]
  selectedTask: MultiloopTask | null
  onClearTaskSelection: () => void
}) {
  const verdicts = useMemo(() => {
    return (milestone?.reviewVerdicts ?? [])
      .filter(isModernVerdict)
      .slice(-3)
      .reverse()
  }, [milestone?.reviewVerdicts])

  const latestRecommendation = verdicts.find((v) => v.nextRecommendation.trim())?.nextRecommendation ?? ''
  const learnedFacts = milestone?.learnedFacts ?? []
  const recentDecisions = decisions.slice(-3).reverse()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-[12px] text-[color:var(--text-muted)]">
          <span className="font-semibold text-[color:var(--text-strong)]">Reassessment</span>
          <span>Iteration {iteration}</span>
        </div>
        {latestRecommendation ? (
          <>
            <div className="mt-2 text-[11px] text-[color:var(--text-muted)]">Next recommendation</div>
            <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{latestRecommendation}</p>
          </>
        ) : (
          <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">
            The loop is waiting for the next reassessment. After a sprint completes, reviewers post verdicts that shape the next milestone.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedTask ? (
          <SelectedTaskCard task={selectedTask} onClear={onClearTaskSelection} />
        ) : null}

        <ReassessSection title="Latest verdicts" emptyText="No reviewer verdicts yet for this milestone.">
          {verdicts.length === 0 ? null : (
            <div className="flex flex-col">
              {verdicts.map((verdict) => (
                <InboxRow
                  key={verdict.id}
                  tone={verdictTone[verdict.verdict]}
                  title={verdictTitle(verdict)}
                  supporting={verdict.nextRecommendation || verdict.finalGoalImplications[0] || undefined}
                  trailing={<span>{verdict.role}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>

        <ReassessSection title="Learned facts" emptyText="No facts learned yet — they accumulate as sprints complete.">
          {learnedFacts.length === 0 ? null : (
            <ul className="space-y-1 px-3 pb-2">
              {learnedFacts.map((fact) => (
                <li key={fact} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
                  <span>{fact}</span>
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Recent evidence" emptyText="No task evidence captured yet.">
          {evidenceTasks.length === 0 ? null : (
            <div className="flex flex-col">
              {evidenceTasks.map((task) => (
                <InboxRow
                  key={task.id}
                  tone={taskStatusTone[task.status]}
                  title={task.title || task.id}
                  supporting={task.evidence.summary || task.evidence.results[0] || undefined}
                  trailing={<span>{formatDate(task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt)}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>

        <ReassessSection title="Decisions" emptyText="No decisions recorded.">
          {recentDecisions.length === 0 ? null : (
            <ul className="space-y-1 px-3 pb-2">
              {recentDecisions.map((decision) => (
                <li key={decision.id} className="text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                  {decision.summary || 'Decision recorded without summary.'}
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Artifacts" emptyText="No artifacts linked to this milestone yet.">
          {artifacts.length === 0 ? null : (
            <div className="flex flex-col">
              {artifacts.map((artifact) => (
                <InboxRow
                  key={artifact.id}
                  tone="neutral"
                  title={artifact.title}
                  supporting={artifact.path ? <span className="break-all font-mono text-[11px]">{artifact.path}</span> : undefined}
                  trailing={<span>{artifact.kind || 'artifact'}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>
      </div>
    </div>
  )
}

function ReassessSection({ title, emptyText, children }: { title: string; emptyText: string; children: ReactNode }) {
  const hasChildren = Boolean(children) && (Array.isArray(children) ? children.some(Boolean) : true)
  return (
    <Section title={title} inset={false}>
      {hasChildren ? children : (
        <p className="px-3 pb-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">{emptyText}</p>
      )}
    </Section>
  )
}

function SelectedTaskCard({ task, onClear }: { task: MultiloopTask; onClear: () => void }) {
  const items: DefinitionItem[] = [
    {
      term: 'Status',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={taskStatusTone[task.status]} />
          <span>{taskStatusLabels[task.status]}</span>
        </span>
      ),
    },
    { term: 'Role', description: task.role },
  ]
  if (task.ownerAgentId) items.push({ term: 'Owner', description: task.ownerAgentId })

  return (
    <Section
      title={task.title || task.id}
      action={(
        <IconButton
          aria-label="Clear task selection"
          onClick={onClear}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path
              d="M3 3L9 9M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      )}
    >
      <DefinitionList items={items} />
      {task.description ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{task.description}</p>
      ) : null}
      {task.acceptanceCriteria.length ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--text-muted)]">Acceptance</div>
          <ul className="mt-1 space-y-1">
            {task.acceptanceCriteria.map((item) => (
              <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.blockers.length ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--tone-warn)]">Blockers</div>
          <ul className="mt-1 space-y-1">
            {task.blockers.map((item) => (
              <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                <StatusDot tone="warn" className="mt-1.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}

