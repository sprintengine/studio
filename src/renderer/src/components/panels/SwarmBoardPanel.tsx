import React, { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  SwarmRole,
  SwarmTask,
  SwarmTaskBoardColumn,
  SwarmTaskStatus,
} from '../../types/workspace'
import {
  buildSwarmAgentRoster,
  getSwarmTaskBoardColumn,
  swarmRoleAccent,
  swarmRoleLabels,
} from '../../utils/swarm'

const columnMeta: { key: SwarmTaskBoardColumn; label: string; tint: string }[] = [
  { key: 'todo', label: 'Todo', tint: 'bg-zinc-900/80 text-zinc-400' },
  { key: 'ready', label: 'Ready', tint: 'bg-sky-950/50 text-sky-300' },
  { key: 'in_progress', label: 'In Progress', tint: 'bg-amber-950/50 text-amber-300' },
  { key: 'needs_input', label: 'Needs Input', tint: 'bg-rose-950/50 text-rose-300' },
  { key: 'done', label: 'Done', tint: 'bg-zinc-800/80 text-zinc-200' },
]

const roleTone: Record<SwarmRole, string> = {
  architect: 'border-[#5a6476] bg-[#1a1d23] text-zinc-100',
  developer: 'border-[#3d4658] bg-[#171a20] text-zinc-200',
  frontend: 'border-[#4c4a63] bg-[#1a1823] text-zinc-200',
  tester: 'border-[#3c5648] bg-[#151d1a] text-zinc-200',
  security: 'border-[#6a3d46] bg-[#221519] text-zinc-200',
}

const phaseTone: Record<string, string> = {
  planning: 'border-[#3a4150] bg-[#171a20] text-zinc-300',
  awaiting_approval: 'border-[#5f4b2d] bg-[#1d1813] text-amber-200',
  executing: 'border-[#324558] bg-[#151a22] text-sky-200',
  completed: 'border-[#335245] bg-[#141b18] text-emerald-200',
}

const taskStateLabel: Record<SwarmTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  done: 'Done',
}

interface Props {
  workspaceId: string
}

export default function SwarmBoardPanel({ workspaceId }: Props) {
  const swarmState = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.swarmState
  )
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const roster = useMemo(
    () => buildSwarmAgentRoster(swarmState?.roleCounts ?? swarmState?.agentCount ?? 4),
    [swarmState?.roleCounts, swarmState?.agentCount]
  )

  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.id, agent])),
    [roster]
  )

  const visibleRoles = useMemo(() => {
    return (Object.entries(swarmState?.roleCounts ?? {}) as Array<[SwarmRole, number]>)
      .filter(([, count]) => count > 0)
      .map(([role]) => role)
  }, [swarmState?.roleCounts])

  const boardColumns = useMemo(() => {
    if (!swarmState) return []

    return columnMeta.map((column) => ({
      ...column,
      cards: swarmState.tasks.filter(
        (task) => getSwarmTaskBoardColumn(task, swarmState.tasks, swarmState.planApproved) === column.key
      ),
    }))
  }, [swarmState])

  const selectedTask = swarmState?.tasks.find((task) => task.id === selectedTaskId) ?? null

  if (!swarmState) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0f1012] text-sm text-zinc-500">
        Swarm workspace data is missing.
      </div>
    )
  }

  const doneCount = swarmState.tasks.filter((task) => task.status === 'done').length
  const activeCount = swarmState.tasks.filter((task) => task.status === 'in_progress').length
  const needsInputCount = swarmState.tasks.filter((task) => task.status === 'needs_input').length

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0f1012] text-zinc-100">
      <div className="border-b border-[#23262d] bg-[#121419] px-5 py-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              Swarm Mode
            </div>
            <h2 className="truncate text-[20px] font-semibold tracking-tight text-zinc-100">Goal</h2>
            <p className="mt-1 max-w-4xl text-[13px] leading-6 text-zinc-300">{swarmState.goal}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Phase" value={swarmState.phase.replace('_', ' ')} tone={phaseTone[swarmState.phase]} />
            <MetricCard
              label="Plan"
              value={swarmState.planApproved ? 'Approved' : 'Awaiting Approval'}
              tone={swarmState.planApproved ? 'border-[#365149] bg-[#151d1a] text-emerald-200' : 'border-[#5f4b2d] bg-[#1d1813] text-amber-200'}
            />
            <MetricCard label="Done" value={`${doneCount}/${swarmState.tasks.length}`} tone="border-[#2f3540] bg-[#171b22] text-zinc-100" />
            <MetricCard label="Active" value={`${activeCount} running / ${needsInputCount} waiting`} tone="border-[#2f3540] bg-[#171b22] text-zinc-100" />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {visibleRoles.map((role) => {
            const count = swarmState.roleCounts[role]
            return (
              <div key={role} className={`rounded-xl border px-3 py-3 ${roleTone[role]}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                      {swarmRoleLabels[role]}
                    </div>
                    <div className="mt-2 text-sm font-medium">
                      {count} {count === 1 ? 'specialist' : 'specialists'}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-400">Preconfigured role</div>
                  </div>
                  <div
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: swarmRoleAccent[role], boxShadow: `0 0 14px ${swarmRoleAccent[role]}` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid flex-1 gap-3 overflow-x-auto overflow-y-hidden bg-[#101216] p-4 lg:grid-cols-3 xl:grid-cols-5">
        {boardColumns.map((column) => (
          <section
            key={column.key}
            className="flex min-w-[260px] flex-col rounded-2xl border border-[#23262d] bg-[#14161a]"
          >
            <div className="flex items-center justify-between border-b border-[#23262d] px-4 py-3">
              <div className="text-sm font-semibold text-zinc-100">{column.label}</div>
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${column.tint}`}
              >
                {column.cards.length}
              </span>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {column.cards.map((task) => {
                const ownerLabel = getTaskOwnerLabel(task, rosterById)
                return (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                    className="w-full rounded-xl border border-[#2a2e36] bg-[#181b20] p-3 text-left transition-colors hover:border-[#3a4150] hover:bg-[#1b1f26]"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-zinc-100">{task.title}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                          {task.id} • {swarmRoleLabels[task.role]}
                        </div>
                      </div>
                      <span className="rounded-full border border-[#303542] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                        {ownerLabel}
                      </span>
                    </div>

                    <p className="text-[12px] leading-5 text-zinc-400">{task.description}</p>

                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                      <span className="rounded-full border border-[#2c313b] px-2 py-1">
                        {task.ownedPaths.length} paths
                      </span>
                      <span className="rounded-full border border-[#2c313b] px-2 py-1">
                        {task.acceptanceCriteria.length} checks
                      </span>
                      {task.dependsOn.length > 0 ? (
                        <span className="rounded-full border border-[#2c313b] px-2 py-1">
                          {task.dependsOn.length} deps
                        </span>
                      ) : null}
                    </div>

                    {task.notes[0] ? (
                      <div className="mt-3 rounded-lg border border-[#23262d] bg-[#16191d] px-3 py-2 text-[11px] leading-5 text-zinc-400">
                        {task.notes[0]}
                      </div>
                    ) : null}
                  </button>
                )
              })}

              {column.cards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-4 text-[12px] text-zinc-600">
                  No tasks here yet
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      {selectedTask && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[900px] overflow-y-auto rounded-2xl border border-[#303542] bg-[#121419] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#23262d] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Task Detail
                </div>
                <h3 className="text-[20px] font-semibold tracking-tight text-zinc-100">
                  {selectedTask.title}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">{selectedTask.id}</span>
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">
                    {swarmRoleLabels[selectedTask.role]}
                  </span>
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">
                    {taskStateLabel[selectedTask.status]}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedTaskId(null)}
                className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-zinc-300">
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Description
                </div>
                <p>{selectedTask.description}</p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <InfoCard
                  label="Owner"
                  value={getTaskOwnerLabel(selectedTask, rosterById)}
                />
                <InfoCard
                  label="Dependencies"
                  value={selectedTask.dependsOn.join(', ') || 'None'}
                />
                <InfoCard
                  label="Started"
                  value={formatTimestamp(selectedTask.startedAt)}
                />
              </div>

              <SectionList title="Owned Paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
              <SectionList
                title="Acceptance Criteria"
                items={selectedTask.acceptanceCriteria}
                emptyLabel="No acceptance criteria recorded."
              />
              <SectionList
                title="Implementation Notes"
                items={selectedTask.implementationNotes}
                emptyLabel="No implementation notes recorded."
              />
              <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />
              <SectionList
                title="Questions For User"
                items={selectedTask.questionsForUser}
                emptyLabel="No outstanding questions."
              />

              <div className="grid gap-4 md:grid-cols-2">
                <SectionList
                  title="Commands Run"
                  items={selectedTask.evidence.commandsRan}
                  emptyLabel="No commands recorded."
                />
                <SectionList
                  title="Results"
                  items={selectedTask.evidence.results}
                  emptyLabel="No test or validation results recorded."
                />
              </div>

              <SectionList
                title="Touched Files"
                items={selectedTask.evidence.touchedFiles}
                emptyLabel="No touched files recorded."
              />

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Evidence Summary
                </div>
                <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3 text-zinc-200">
                  {selectedTask.evidence.summary || 'No completion summary recorded yet.'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-right ${tone}`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-1 text-[18px] font-semibold capitalize">{value}</div>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-2 font-medium text-zinc-100">{value}</div>
    </div>
  )
}

function SectionList({
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
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-2 text-zinc-300">
          {items.map((item) => (
            <li key={item} className="rounded-lg border border-[#23262d] bg-[#171a20] px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-3 text-[12px] text-zinc-600">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function formatTimestamp(value: number | null): string {
  if (!value) return 'Not started'
  return new Date(value).toLocaleString()
}

function getTaskOwnerLabel(
  task: SwarmTask,
  rosterById: Record<string, { label: string } | undefined>
): string {
  if (task.ownerAgentId) {
    return rosterById[task.ownerAgentId]?.label ?? task.ownerAgentId
  }

  return task.status === 'done' ? swarmRoleLabels[task.role] : 'Unclaimed'
}
