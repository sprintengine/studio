import React, { useMemo, useState } from 'react'
import { buildSwarmAgentRoster } from '../../layouts/templates'
import type { SwarmMockConfig, SwarmRole } from '../../types/workspace'

type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'review' | 'testing' | 'done'

type MockTask = {
  id: string
  title: string
  description: string
  owner: string
  status: TaskStatus
  dependsOn?: string[]
  details: string[]
}

const columnMeta: { key: TaskStatus; label: string; tint: string }[] = [
  { key: 'backlog', label: 'Backlog', tint: 'bg-zinc-900/80 text-zinc-400' },
  { key: 'ready', label: 'Ready', tint: 'bg-sky-950/50 text-sky-300' },
  { key: 'in_progress', label: 'In Progress', tint: 'bg-amber-950/50 text-amber-300' },
  { key: 'review', label: 'Review', tint: 'bg-indigo-950/50 text-indigo-300' },
  { key: 'testing', label: 'Testing', tint: 'bg-emerald-950/50 text-emerald-300' },
  { key: 'done', label: 'Done', tint: 'bg-zinc-800/80 text-zinc-200' },
]

const roleLabels: Record<SwarmRole, string> = {
  architect: 'Architect',
  developer: 'Developer',
  frontend: 'Frontend / UX',
  tester: 'Tester',
}

const roleTone: Record<SwarmRole, string> = {
  architect: 'border-[#5a6476] bg-[#1a1d23] text-zinc-100',
  developer: 'border-[#3d4658] bg-[#171a20] text-zinc-200',
  frontend: 'border-[#4c4a63] bg-[#1a1823] text-zinc-200',
  tester: 'border-[#3c5648] bg-[#151d1a] text-zinc-200',
}

function buildMockTasks(config: SwarmMockConfig): MockTask[] {
  const roster = buildSwarmAgentRoster(config.agentCount)
  const developer = roster.find((agent) => agent.role === 'developer')?.id ?? 'developer-1'
  const frontend = roster.find((agent) => agent.role === 'frontend')?.id ?? developer
  const tester = roster.find((agent) => agent.role === 'tester')?.id ?? developer
  const goal = config.goal.trim() || 'Deliver the swarm workspace experience'

  return [
    {
      id: 'task-1',
      title: 'Audit the workspace flow',
      description: `Architect reviews the current app shell and translates "${goal}" into a dependency-aware implementation plan.`,
      owner: 'architect',
      status: 'done',
      details: [
        'Map the create-workspace entry points.',
        'Identify which layout regions need to disappear in swarm mode.',
        'Capture orchestration constraints for worker handoff.',
      ],
    },
    {
      id: 'task-2',
      title: 'Draft swarm task graph',
      description: 'Architect breaks the goal into ordered cards, acceptance criteria, and dependency links.',
      owner: 'architect',
      status: 'review',
      dependsOn: ['task-1'],
      details: [
        'Define task ownership and sequence.',
        'Mark which tasks are safe for specialist workers.',
        'Publish the initial sprint board structure.',
      ],
    },
    {
      id: 'task-3',
      title: 'Design swarm workspace UI',
      description: 'Frontend / UX engineer explores the board layout, detail modal, and live activity treatment.',
      owner: frontend,
      status: 'in_progress',
      dependsOn: ['task-2'],
      details: [
        'Create kanban lane styling that matches Multicode.',
        'Design the task detail modal interaction.',
        'Refine the right-side specialist CLI presentation.',
      ],
    },
    {
      id: 'task-4',
      title: 'Build swarm creation tab',
      description: 'Developer wires the new swarm mode tab, goal input, and role skill configuration.',
      owner: developer,
      status: 'ready',
      dependsOn: ['task-2'],
      details: [
        'Capture goal, agent count, and role skills.',
        'Generate the swarm workspace layout from selections.',
        'Preserve the current standard workspace flow.',
      ],
    },
    {
      id: 'task-5',
      title: 'Implement worker orchestration shell',
      description: 'Developer connects plan creation, task assignment, and ordered dependency execution.',
      owner: developer,
      status: 'backlog',
      dependsOn: ['task-4'],
      details: [
        'Model task lifecycle state.',
        'Wake workers only when dependencies are satisfied.',
        'Send compact context packets rather than full repo scans.',
      ],
    },
    {
      id: 'task-6',
      title: 'Validate testing and review loop',
      description: 'Tester verifies task transitions, acceptance criteria capture, and board progress updates.',
      owner: tester,
      status: 'testing',
      dependsOn: ['task-3', 'task-4'],
      details: [
        'Confirm done work always passes through review/testing.',
        'Surface regressions in dependency ordering.',
        'Check that task history is readable for the user.',
      ],
    },
  ]
}

export default function SwarmBoardPanel({ config }: { config?: Partial<SwarmMockConfig> }) {
  const safeConfig: SwarmMockConfig = {
    goal: config?.goal ?? 'Launch swarm mode',
    agentCount: config?.agentCount ?? 4,
    skills: config?.skills ?? { architect: [], developer: [], frontend: [], tester: [] },
  }
  const [selectedTask, setSelectedTask] = useState<MockTask | null>(null)
  const roster = useMemo(() => buildSwarmAgentRoster(safeConfig.agentCount), [safeConfig.agentCount])
  const tasks = useMemo(() => buildMockTasks(safeConfig), [safeConfig])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0f1012] text-zinc-100">
      <div className="border-b border-[#23262d] bg-[#121419] px-5 py-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Swarm Mode</div>
            <h2 className="truncate text-[20px] font-semibold tracking-tight text-zinc-100">Goal</h2>
            <p className="mt-1 max-w-4xl text-[13px] leading-6 text-zinc-300">{safeConfig.goal}</p>
          </div>
          <div className="rounded-xl border border-[#2c313b] bg-[#171a20] px-4 py-3 text-right">
            <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Active Specialists</div>
            <div className="mt-1 text-[18px] font-semibold text-zinc-100">{roster.length}</div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(['architect', 'developer', 'frontend', 'tester'] as SwarmRole[]).map((role) => {
            const skills = safeConfig.skills[role]
            return (
              <div key={role} className={`rounded-xl border px-3 py-3 ${roleTone[role]}`}>
                <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{roleLabels[role]}</div>
                <div className="mt-2 text-sm font-medium">
                  {skills.length > 0 ? skills.join(', ') : 'No extra skills selected'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid flex-1 gap-3 overflow-x-auto overflow-y-hidden bg-[#101216] p-4 lg:grid-cols-3 xl:grid-cols-6">
        {columnMeta.map((column) => {
          const cards = tasks.filter((task) => task.status === column.key)
          return (
            <section key={column.key} className="flex min-w-[250px] flex-col rounded-2xl border border-[#23262d] bg-[#14161a]">
              <div className="flex items-center justify-between border-b border-[#23262d] px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">{column.label}</div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${column.tint}`}>
                  {cards.length}
                </span>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto p-3">
                {cards.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTask(task)}
                    className="w-full rounded-xl border border-[#2a2e36] bg-[#181b20] p-3 text-left transition-colors hover:border-[#3a4150] hover:bg-[#1b1f26]"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-zinc-100">{task.title}</span>
                      <span className="rounded-full border border-[#303542] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                        {task.owner}
                      </span>
                    </div>
                    <p className="text-[12px] leading-5 text-zinc-400">{task.description}</p>
                    {task.dependsOn?.length ? (
                      <div className="mt-3 text-[10px] uppercase tracking-[0.12em] text-zinc-600">
                        Depends on {task.dependsOn.join(', ')}
                      </div>
                    ) : null}
                  </button>
                ))}
                {cards.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-4 text-[12px] text-zinc-600">
                    No tasks here yet
                  </div>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>

      {selectedTask && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[720px] rounded-2xl border border-[#303542] bg-[#121419] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#23262d] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Task Detail</div>
                <h3 className="text-[20px] font-semibold tracking-tight text-zinc-100">{selectedTask.title}</h3>
              </div>
              <button
                onClick={() => setSelectedTask(null)}
                className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
              >
                Close
              </button>
            </div>
            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-zinc-300">
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Description</div>
                <p>{selectedTask.description}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Owner</div>
                  <div className="mt-2 font-medium text-zinc-100">{selectedTask.owner}</div>
                </div>
                <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Dependencies</div>
                  <div className="mt-2 font-medium text-zinc-100">
                    {selectedTask.dependsOn?.join(', ') || 'None'}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Acceptance Notes</div>
                <ul className="space-y-2 text-zinc-300">
                  {selectedTask.details.map((detail) => (
                    <li key={detail} className="rounded-lg border border-[#23262d] bg-[#171a20] px-3 py-2">
                      {detail}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
