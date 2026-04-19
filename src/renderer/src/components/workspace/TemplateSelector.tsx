import React, { useEffect, useMemo, useState } from 'react'
import { createSwarmTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import type { LayoutTemplate, PreviewSlot, SwarmMockConfig, SwarmRole } from '../../types/workspace'

interface Props {
  onCreate: (args: { template: LayoutTemplate; name: string; folderPath: string | null }) => void
  onClose: () => void
  allowClose?: boolean
}

const swarmSkillOptions: Record<SwarmRole, string[]> = {
  architect: ['Repo analysis', 'Planning', 'Task decomposition', 'Dependency mapping'],
  developer: ['Refactoring', 'Backend APIs', 'Data modeling', 'Integration work'],
  frontend: ['Next.js', 'UI systems', 'UX design', 'Responsive layouts'],
  tester: ['Regression checks', 'Acceptance review', 'QA notes', 'Test planning'],
}

const roleLabels: Record<SwarmRole, string> = {
  architect: 'Architect',
  developer: 'Developer',
  frontend: 'Frontend / UX Engineer',
  tester: 'Tester',
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function createEmptySkillMap(): Record<SwarmRole, string[]> {
  return {
    architect: [],
    developer: [],
    frontend: [],
    tester: [],
  }
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true }: Props) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [mode, setMode] = useState<'standard' | 'swarm'>('standard')
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmGoal, setSwarmGoal] = useState('')
  const [swarmAgents, setSwarmAgents] = useState(4)
  const [swarmSkills, setSwarmSkills] = useState<Record<SwarmRole, string[]>>(createEmptySkillMap())

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && allowClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose])

  const selected = LAYOUT_TEMPLATES.find((template) => template.id === selectedId) ?? LAYOUT_TEMPLATES[0]
  const canCreate = name.trim().length > 0 && (mode === 'standard' || swarmGoal.trim().length > 0)

  const swarmConfig = useMemo<SwarmMockConfig>(
    () => ({
      goal: swarmGoal.trim(),
      agentCount: swarmAgents,
      skills: swarmSkills,
    }),
    [swarmGoal, swarmAgents, swarmSkills]
  )

  const handlePick = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setFolderPath(dir)
    if (!nameTouched) setName(basename(dir) || 'workspace')
  }

  const toggleSkill = (role: SwarmRole, skill: string) => {
    setSwarmSkills((current) => ({
      ...current,
      [role]: current[role].includes(skill)
        ? current[role].filter((item) => item !== skill)
        : [...current[role], skill],
    }))
  }

  const handleCreate = () => {
    if (!canCreate) return
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    onCreate({ template, name: name.trim(), folderPath })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#08080a]/95"
      onClick={(event) => allowClose && event.target === event.currentTarget && onClose()}
    >
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.018) 0, rgba(255,255,255,0.018) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div className="relative mx-5 my-10 w-full max-w-[1180px]">
        <div className="overflow-hidden rounded-2xl border border-[#23262d] bg-[#0f1012] shadow-[0_28px_70px_rgba(0,0,0,0.55)]">
          <div className="flex items-start justify-between gap-4 border-b border-[#23262d] bg-[#101114] px-6 py-4">
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Workspace</div>
              <h1 className="m-0 text-[22px] font-semibold tracking-tight text-zinc-100">New Workspace</h1>
            </div>
            {allowClose && (
              <button
                onClick={onClose}
                className="h-9 rounded-[10px] border border-[#23262d] bg-[#14161a] px-3 text-sm text-zinc-400 transition-colors hover:bg-[#1a1c20] hover:text-zinc-200"
              >
                Cancel
              </button>
            )}
          </div>

          <div className="grid gap-5 p-6">
            <section className="rounded-2xl border border-[#23262d] bg-[#111214] p-5">
              <div className="grid gap-3" style={{ gridTemplateColumns: '1fr auto' }}>
                <div className="flex min-h-[52px] items-center gap-3 rounded-xl border border-[#23262d] bg-[#14161a] px-4">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">Folder</span>
                    <span className="truncate font-mono text-sm text-zinc-200">
                      {folderPath ?? 'No folder selected'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handlePick}
                  className="min-h-[52px] rounded-xl border border-[#2d3139] bg-[#1a1c20] px-5 text-sm font-medium text-zinc-200 transition-colors hover:bg-[#1f2127]"
                >
                  Choose Folder
                </button>
              </div>

              <div className="mt-3 flex min-h-[52px] items-center gap-3 rounded-xl border border-[#23262d] bg-[#14161a] px-4">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">Workspace Name</span>
                  <input
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      setNameTouched(true)
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && handleCreate()}
                    placeholder="my-workspace"
                    className="border-0 bg-transparent font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                  />
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-[#23262d] bg-[#111214] p-5">
              <div className="mb-5 inline-flex rounded-xl border border-[#23262d] bg-[#14161a] p-1">
                {[
                  { id: 'standard' as const, label: 'Standard' },
                  { id: 'swarm' as const, label: 'Swarm Mode' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setMode(tab.id)}
                    className={`rounded-[10px] px-4 py-2 text-sm font-medium transition-colors ${
                      mode === tab.id
                        ? 'bg-zinc-200 text-zinc-950'
                        : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {mode === 'standard' ? (
                <>
                  <div className="mb-4 flex items-baseline justify-between">
                    <h2 className="m-0 text-[15px] font-semibold tracking-tight text-zinc-200">Template</h2>
                    <span className="text-xs text-zinc-500">{selected.description}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    {LAYOUT_TEMPLATES.map((template) => {
                      const isSelected = template.id === selectedId
                      return (
                        <button
                          key={template.id}
                          onClick={() => setSelectedId(template.id)}
                          className={`group flex flex-col gap-3 rounded-2xl border p-3 text-left transition-all focus:outline-none ${
                            isSelected
                              ? 'border-[#5d616c] bg-[#1a1c20]'
                              : 'border-[#23262d] bg-[#14161a] hover:-translate-y-px hover:border-[#2d3139] hover:bg-[#17191d]'
                          }`}
                        >
                          <div className="overflow-hidden rounded-xl border border-[#1f2229] bg-[#0c0d10]">
                            <LayoutPreview slots={template.previewSlots} />
                          </div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-[15px] font-semibold tracking-tight text-zinc-100">
                                {template.name}
                              </div>
                              <div className="mt-0.5 truncate text-xs text-zinc-500">{template.description}</div>
                            </div>
                            <span
                              className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${
                                isSelected ? 'bg-[#343740] text-zinc-100' : 'bg-[#23252b] text-zinc-500'
                              }`}
                            >
                              {agentCountLabel(template.previewSlots)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                  <div className="space-y-5">
                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                        Swarm Goal
                      </div>
                      <textarea
                        value={swarmGoal}
                        onChange={(event) => setSwarmGoal(event.target.value)}
                        placeholder="Describe the overall outcome you want the architect and workers to achieve..."
                        className="min-h-[140px] w-full rounded-xl border border-[#23262d] bg-[#101216] px-4 py-3 text-sm leading-6 text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-[#3d4252]"
                      />
                    </div>

                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-3 flex items-center justify-between gap-4">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Agent Count</div>
                        <div className="text-xs text-zinc-500">Architect plus specialist workers</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
                        {[1, 2, 3, 4, 5, 10].map((count) => (
                          <button
                            key={count}
                            onClick={() => setSwarmAgents(count)}
                            className={`rounded-xl border px-3 py-3 text-sm font-semibold transition-colors ${
                              swarmAgents === count
                                ? 'border-[#4d4d51] bg-zinc-200 text-zinc-950'
                                : 'border-[#23262d] bg-[#101216] text-zinc-400 hover:border-[#2f3540] hover:text-zinc-100'
                            }`}
                          >
                            {count}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-4 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Role Skills</div>
                      <div className="grid gap-4 md:grid-cols-2">
                        {(Object.keys(swarmSkillOptions) as SwarmRole[]).map((role) => (
                          <div key={role} className="rounded-xl border border-[#23262d] bg-[#101216] p-4">
                            <div className="mb-3 text-sm font-semibold text-zinc-100">{roleLabels[role]}</div>
                            <div className="space-y-2">
                              {swarmSkillOptions[role].map((skill) => {
                                const checked = swarmSkills[role].includes(skill)
                                return (
                                  <label
                                    key={skill}
                                    className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-300"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleSkill(role, skill)}
                                      className="h-4 w-4 rounded border-[#3a3f48] bg-[#0f1012]"
                                    />
                                    <span>{skill}</span>
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Workspace Preview</div>
                          <div className="mt-1 text-lg font-semibold text-zinc-100">Swarm Board</div>
                        </div>
                        <span className="rounded-full border border-[#2f3540] bg-[#171b22] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                          {swarmAgents} agents
                        </span>
                      </div>
                      <SwarmCreatePreview goal={swarmGoal} skills={swarmSkills} />
                    </div>

                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                        What Opens
                      </div>
                      <ul className="space-y-2 text-sm leading-6 text-zinc-300">
                        <li>Central kanban board with live task creation and progress.</li>
                        <li>Task detail modal on click for description and acceptance notes.</li>
                        <li>Right-side specialist CLI panes for each active worker.</li>
                        <li>No file explorer or code editor in the initial swarm view.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[#23262d] bg-[#0f1012] px-6 py-5">
            <div className="text-xs text-zinc-500">
              {mode === 'standard'
                ? 'Workspace opens in a new tab with its own layout and agents.'
                : 'Swarm mode opens a kanban board with live specialist agents on the right.'}
            </div>
            <div className="flex gap-2">
              {allowClose && (
                <button
                  onClick={onClose}
                  className="h-11 rounded-xl border border-[#23262d] bg-[#14161a] px-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-[#1a1c20]"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className="h-11 rounded-xl border border-[#4d4d51] bg-zinc-200 px-5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:opacity-40 disabled:hover:bg-zinc-200"
              >
                {mode === 'swarm' ? 'Create Swarm Workspace' : 'Create Workspace'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function agentCountLabel(slots: PreviewSlot[]): string {
  const n = slots.filter((slot) => slot.type === 'agent').length
  return n === 1 ? '1 agent' : `${n} agents`
}

function LayoutPreview({ slots }: { slots: PreviewSlot[] }) {
  const style: Record<PreviewSlot['type'], { fill: string; stroke: string; text: string; glow: string }> = {
    explorer: {
      fill: 'url(#grad-files)',
      stroke: 'rgba(255, 206, 107, 0.40)',
      text: '#f3d69e',
      glow: 'rgba(255, 198, 84, 0.18)',
    },
    editor: {
      fill: 'url(#grad-editor)',
      stroke: 'rgba(111, 219, 145, 0.38)',
      text: '#b8f2c8',
      glow: 'rgba(72, 181, 106, 0.18)',
    },
    agent: {
      fill: 'url(#grad-agent)',
      stroke: 'rgba(85, 147, 255, 0.42)',
      text: '#a9c8ff',
      glow: 'rgba(57, 118, 255, 0.20)',
    },
  }

  return (
    <svg viewBox="0 0 300 110" className="block h-[110px] w-full" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad-agent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(15,30,48,0.98)" />
          <stop offset="100%" stopColor="rgba(12,22,34,0.98)" />
        </linearGradient>
        <linearGradient id="grad-editor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(20,32,24,0.98)" />
          <stop offset="100%" stopColor="rgba(15,23,18,0.98)" />
        </linearGradient>
        <linearGradient id="grad-files" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(42,33,14,0.98)" />
          <stop offset="100%" stopColor="rgba(31,25,12,0.98)" />
        </linearGradient>
        <pattern id="dots" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="rgba(255,255,255,0.04)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="300" height="110" fill="#0c0d10" />
      <rect x="0" y="0" width="300" height="110" fill="url(#dots)" />
      {slots.map((slot, index) => {
        const c = style[slot.type]
        return (
          <g key={index}>
            <rect
              x={slot.x}
              y={slot.y}
              width={slot.w}
              height={slot.h}
              rx="6"
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth="0.8"
              style={{ filter: `drop-shadow(0 0 6px ${c.glow})` }}
            />
            <text
              x={slot.x + slot.w / 2}
              y={slot.y + slot.h / 2 + 3}
              textAnchor="middle"
              fontSize={slot.w < 70 ? '7' : '8'}
              fontWeight="700"
              letterSpacing="0.08em"
              fill={c.text}
              fontFamily="ui-monospace, monospace"
            >
              {slot.label.toUpperCase()}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function SwarmCreatePreview({
  goal,
  skills,
}: {
  goal: string
  skills: Record<SwarmRole, string[]>
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#1f2229] bg-[#0c0d10]">
      <div className="border-b border-[#23262d] bg-[#111318] px-4 py-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Swarm Page Mockup</div>
        <div className="mt-1 text-sm font-medium text-zinc-100">
          {goal.trim() || 'Your high-level swarm goal will appear here'}
        </div>
      </div>
      <div className="grid gap-3 bg-[#0f1012] p-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-[#23262d] bg-[#14161a] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold text-zinc-200">Kanban Board</div>
            <span className="rounded-full border border-[#2f3540] bg-[#171b22] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
              Live
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {['Backlog', 'In Progress', 'Done'].map((lane, index) => (
              <div key={lane} className="rounded-lg border border-[#23262d] bg-[#101216] p-2">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">{lane}</div>
                <div className={`rounded-md p-2 text-[11px] leading-5 ${
                  index === 1 ? 'bg-amber-950/40 text-amber-200' : index === 2 ? 'bg-zinc-800 text-zinc-100' : 'bg-[#181b20] text-zinc-300'
                }`}>
                  {index === 0 && 'Define worker tasks'}
                  {index === 1 && 'Design swarm board UI'}
                  {index === 2 && 'Audit app shell'}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-[#23262d] bg-[#14161a] p-3">
            <div className="mb-2 text-xs font-semibold text-zinc-200">Specialist CLIs</div>
            <div className="space-y-2">
              {(['architect', 'developer', 'frontend', 'tester'] as SwarmRole[]).map((role) => (
                <div key={role} className="rounded-lg border border-[#23262d] bg-[#101216] px-3 py-2">
                  <div className="text-[11px] font-medium text-zinc-100">{roleLabels[role]}</div>
                  <div className="mt-1 text-[10px] text-zinc-500">
                    {skills[role].length > 0 ? skills[role].join(', ') : 'Default role prompt'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
