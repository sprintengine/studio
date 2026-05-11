import React, { useMemo } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import {
  buildRunSummary,
  formatSprintEngineGoal,
} from '../../utils/sprintengineRunSummary'

type Props = {
  workspaceId: string
  onClose: () => void
}

export default function SprintEngineRunSummaryPanel({ workspaceId, onClose }: Props) {
  const sprintEngineState = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState ?? null
  )

  const runSummary = useMemo(
    () => buildRunSummary(sprintEngineState?.tasks ?? []),
    [sprintEngineState?.tasks]
  )

  if (!sprintEngineState) {
    return (
      <WorkspacePanel
        title="Run Summary"
        subtitle="Sprint Engine state is not available for this workspace."
        titleId="sprintengine-run-summary-title"
        onClose={onClose}
        closeLabel="Close run summary"
      >
        <div className="border-l-2 border-[#303139] pl-3 text-[13px] leading-6 text-[#9a9aa2]">
          Open a Sprint Engine workspace to see its run summary.
        </div>
      </WorkspacePanel>
    )
  }

  return (
    <WorkspacePanel
      title="Run Summary"
      subtitle={formatSprintEngineGoal(sprintEngineState.goal)}
      titleId="sprintengine-run-summary-title"
      onClose={onClose}
      closeLabel="Close run summary"
      contentClassName="w-full max-w-[960px] px-5 py-5"
    >
      <div className="space-y-5 text-[13px] leading-6 text-[#d7d7dc]">
        <div className="grid gap-x-6 gap-y-3 border-b border-[#1f2025] pb-5 sm:grid-cols-2 md:grid-cols-4">
          <RunSummaryMeta label="Tasks Done" value={`${runSummary.completedTasks}/${runSummary.totalTasks}`} />
          <RunSummaryMeta label="Files Touched" value={String(runSummary.touchedFiles.length)} />
          <RunSummaryMeta label="Commands" value={String(runSummary.commandsRan.length)} />
          <RunSummaryMeta label="Results" value={String(runSummary.results.length)} />
        </div>

        <RunSummarySection title="Completed Tasks" items={runSummary.taskSummaries} emptyLabel="No completed tasks recorded." />
        <RunSummarySection title="Agent Feedback" items={runSummary.feedbackSummaries} emptyLabel="No agent feedback recorded." />
        <RunSummarySection title="Prompt Improvement Signals" items={runSummary.promptImprovementSignals} emptyLabel="No prompt improvement signals recorded." />
        <RunSummarySection title="Role Findings" items={runSummary.findingSummaries} emptyLabel="No role findings recorded." />
        <RunSummarySection title="Touched Files" items={runSummary.touchedFiles} emptyLabel="No touched files recorded." />
        <RunSummarySection title="Commands Run" items={runSummary.commandsRan} emptyLabel="No commands recorded." />
        <RunSummarySection title="Validation Results" items={runSummary.results} emptyLabel="No validation results recorded." />
        <RunSummarySection title="Remaining Questions" items={runSummary.openQuestions} emptyLabel="No open questions remain." />

        <div className="border-l-2 border-[#ffbf2f]/70 bg-[#151106] px-3 py-2 text-[13px] leading-6 text-[#ffe0a3]">
          Next step: manually test the uncommitted changes in the workspace before committing or reverting.
        </div>
      </div>
    </WorkspacePanel>
  )
}

function RunSummaryMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className="mt-1 font-medium tabular-nums text-[#ececee] [overflow-wrap:anywhere]">{value}</div>
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
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-1.5 text-[#d7d7dc]">
          {items.map((item) => (
            <li key={item} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="mt-[0.65rem] h-1 w-1 rounded-full bg-[#5a5a63]" aria-hidden="true" />
              <span className="[overflow-wrap:anywhere]">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] text-[#5a5a63]">{emptyLabel}</div>
      )}
    </div>
  )
}
