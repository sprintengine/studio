import React, { useMemo } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  DefinitionList,
  OverflowMenu,
  PanelHeader,
  Section,
  StatusDot,
  type DefinitionItem,
  type OverflowMenuItem,
} from '../ui'
import {
  buildRunSummary,
  formatSprintEngineGoal,
} from '../../utils/sprintengineRunSummary'
import { formatSprintEngineLockAge } from '../../utils/sprintengine'
import type { SprintEngineProjectionSource } from '../../types/workspace'

const projectionSourceLabel: Record<SprintEngineProjectionSource, string> = {
  folder_store: 'Folder store',
  unavailable: 'Projection unavailable',
}

type Props = {
  workspaceId: string
  onClose: () => void
}

const TITLE_ID = 'sprintengine-run-summary-title'

export default function SprintEngineRunSummaryPanel({ workspaceId, onClose }: Props) {
  const sprintEngineState = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState ?? null
  )

  const runSummary = useMemo(
    () => buildRunSummary(sprintEngineState?.tasks ?? []),
    [sprintEngineState?.tasks]
  )

  const overflowItems = useMemo<OverflowMenuItem[]>(
    () => [{ id: 'close', label: 'Close', onSelect: onClose }],
    [onClose]
  )

  if (!sprintEngineState) {
    return (
      <section
        aria-labelledby={TITLE_ID}
        className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
      >
        <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
          <PanelHeader
            tool="sprintengine"
            title="Run summary"
            titleId={TITLE_ID}
            subtitle="Sprint Engine state is not available for this workspace."
            overflow={<OverflowMenu ariaLabel="Run summary overflow" items={overflowItems} />}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[960px] px-5 py-5">
            <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[13px] leading-6 text-[color:var(--text-muted)]">
              Open a Sprint Engine workspace to see its run summary.
            </div>
          </div>
        </div>
      </section>
    )
  }

  const metrics: DefinitionItem[] = [
    {
      id: 'tasks-done',
      term: 'Tasks done',
      description: (
        <span className="tabular-nums">
          {`${runSummary.completedTasks}/${runSummary.totalTasks}`}
        </span>
      ),
    },
    {
      id: 'files-touched',
      term: 'Files touched',
      description: <span className="tabular-nums">{runSummary.touchedFiles.length}</span>,
    },
    {
      id: 'commands',
      term: 'Commands',
      description: <span className="tabular-nums">{runSummary.commandsRan.length}</span>,
    },
    {
      id: 'results',
      term: 'Results',
      description: <span className="tabular-nums">{runSummary.results.length}</span>,
    },
  ]

  return (
    <section
      aria-labelledby={TITLE_ID}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
    >
      <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
        <PanelHeader
          tool="sprintengine"
          title="Run summary"
          titleId={TITLE_ID}
          subtitle={formatSprintEngineGoal(sprintEngineState.goal)}
          overflow={<OverflowMenu ariaLabel="Run summary overflow" items={overflowItems} />}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-5 py-5">
          <ProjectionStatusBanner state={sprintEngineState} />

          <div className="border-b border-[color:var(--border-default)] pb-4">
            <DefinitionList items={metrics} layout="two-column" />
          </div>

          <RunSummarySection
            title="Completed tasks"
            items={runSummary.taskSummaries}
            emptyLabel="No completed tasks recorded."
          />
          <RunSummarySection
            title="Agent feedback"
            items={runSummary.feedbackSummaries}
            emptyLabel="No agent feedback recorded."
          />
          <RunSummarySection
            title="Prompt improvement signals"
            items={runSummary.promptImprovementSignals}
            emptyLabel="No prompt improvement signals recorded."
          />
          <RunSummarySection
            title="Role findings"
            items={runSummary.findingSummaries}
            emptyLabel="No role findings recorded."
          />
          <RunSummarySection
            title="Touched files"
            items={runSummary.touchedFiles}
            emptyLabel="No touched files recorded."
          />
          <RunSummarySection
            title="Commands run"
            items={runSummary.commandsRan}
            emptyLabel="No commands recorded."
          />
          <RunSummarySection
            title="Validation results"
            items={runSummary.results}
            emptyLabel="No validation results recorded."
          />
          <RunSummarySection
            title="Remaining questions"
            items={runSummary.openQuestions}
            emptyLabel="No open questions remain."
          />

          <div className="mt-2 border-l-2 border-[color:var(--tone-warn)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-[13px] leading-6 text-[color:var(--tone-warn)]">
            Next step: manually test the uncommitted changes in the workspace before committing or
            reverting.
          </div>
        </div>
      </div>
    </section>
  )
}

function ProjectionStatusBanner({
  state,
}: {
  state: import('../../types/workspace').SprintEngineState
}) {
  const projection = state.projection
  const lockWarnings = state.locks?.warnings ?? []
  if (!projection && lockWarnings.length === 0) return null

  const source: SprintEngineProjectionSource = projection?.source ?? 'folder_store'
  const tone: 'good' | 'warn' | 'error' =
    source === 'unavailable' || projection?.errorMessage
      ? 'error'
      : lockWarnings.length > 0
        ? 'warn'
        : 'good'

  return (
    <div className="mb-4 border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-default)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={tone} />
          <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
            Projection
          </span>
        </span>
        <span className="text-[color:var(--text-default)]">{projectionSourceLabel[source]}</span>
        {projection?.errorMessage ? (
          <span className="text-[color:var(--tone-error)] [overflow-wrap:anywhere]">
            {projection.errorMessage}
          </span>
        ) : null}
      </div>
      {lockWarnings.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[color:var(--tone-warn)]">
          {lockWarnings.map((warning) => (
            <li key={warning.name} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="font-mono text-[11px]">
                {warning.name}
              </span>
              <span className="[overflow-wrap:anywhere]">
                {warning.message} ({formatSprintEngineLockAge(warning.ageSeconds)})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function RunSummarySection({
  title,
  items,
  emptyLabel,
}: {
  title: string
  items: string[]
  emptyLabel: string
}) {
  return (
    <Section title={title} count={items.length > 0 ? items.length : undefined} level={3} inset>
      {items.length > 0 ? (
        <ul className="space-y-1.5 text-[13px] leading-6 text-[color:var(--text-default)]">
          {items.map((item) => (
            <li key={item} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span
                aria-hidden="true"
                className="mt-[0.65rem] inline-block h-1 w-1 shrink-0 rounded-full bg-[color:var(--text-disabled)]"
              />
              <span className="[overflow-wrap:anywhere]">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-[color:var(--text-disabled)]">{emptyLabel}</div>
      )}
    </Section>
  )
}
