import { InboxRow, PrimaryButton, Section } from '../../ui'
import type { MultiloopBlocker, MultiloopTask } from '../../../types/workspace'
import type { MultiloopExecutionReadiness } from '../../../utils/multiloop'
import { hasEvidence, readinessLabel, TASK_GROUPS, taskStatusTone } from './helpers'

// ===========================================================================
// TASK BOARD — grouped by status using InboxRow primitives.
// ===========================================================================

export function TaskBoard({
  tasks,
  selectedTaskId,
  onSelectTask,
  source,
  readiness,
  onPlanExecution,
}: {
  tasks: MultiloopTask[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
  source: 'sprintengine' | 'multiloop'
  readiness: MultiloopExecutionReadiness
  onPlanExecution: () => void
}) {
  const sourceLabel = source === 'sprintengine' ? 'Sprint Engine' : 'Multiloop'

  if (tasks.length === 0) {
    return (
      <Section title="Sprint tasks" action={<span className="text-[11px] text-[color:var(--text-muted)]">Source: {sourceLabel}</span>}>
        <p className="text-[12px] text-[color:var(--text-muted)]">{readinessLabel(readiness)}.</p>
        <div className="mt-2">
          <PrimaryButton type="button" onClick={onPlanExecution}>Plan execution</PrimaryButton>
        </div>
      </Section>
    )
  }

  const groups = TASK_GROUPS.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => task.status === group.key),
  })).filter((group) => group.tasks.length > 0)

  return (
    <Section
      title="Sprint tasks"
      count={tasks.length}
      action={<span className="text-[11px] text-[color:var(--text-muted)]">Source: {sourceLabel}</span>}
      inset={false}
    >
      <div className="flex flex-col">
        {groups.map((group) => (
          <div key={group.key}>
            <div className="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
              <div className="flex items-baseline gap-1.5">
                <h4 className="text-[11px] font-semibold text-[color:var(--text-muted)]">{group.label}</h4>
                <span className="tabular-nums text-[11px] text-[color:var(--text-disabled)]">
                  {group.tasks.length}
                </span>
              </div>
            </div>
            <div className="flex flex-col">
              {group.tasks.map((task) => {
                const selected = selectedTaskId === task.id
                const owner = task.ownerAgentId
                const supporting = (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{task.role}</span>
                    {owner ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{owner}</span>
                      </>
                    ) : null}
                    {hasEvidence(task) ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Evidence</span>
                      </>
                    ) : null}
                  </span>
                )
                return (
                  <InboxRow
                    key={task.id}
                    tone={taskStatusTone[task.status]}
                    title={task.title || task.id}
                    supporting={supporting}
                    trailing={<span className="font-mono">{task.id}</span>}
                    selected={selected}
                    onSelect={() => onSelectTask(task.id)}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

export function BlockersPanel({ blockers }: { blockers: MultiloopBlocker[] }) {
  if (blockers.length === 0) return null
  return (
    <Section title="Active blockers" count={blockers.length} inset={false}>
      <div className="flex flex-col">
        {blockers.map((blocker) => (
          <InboxRow
            key={blocker.id}
            tone="warn"
            title={blocker.summary}
            supporting={blocker.detail || undefined}
            trailing={<span>{blocker.scope}</span>}
          />
        ))}
      </div>
    </Section>
  )
}

