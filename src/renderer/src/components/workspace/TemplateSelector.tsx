import React, { useEffect, useMemo, useState } from 'react'
import { createSwarmTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import type {
  LayoutTemplate,
  PreviewSlot,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmState,
} from '../../types/workspace'
import {
  countSwarmAgents,
  createDefaultSwarmRoleCounts,
  createDefaultSwarmSkills,
  swarmRoleAccent,
  swarmRoleLabels,
  swarmTeamPresets,
} from '../../utils/swarm'

interface Props {
  onCreate: (args: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    swarmState?: SwarmState | null
  }) => void
  onClose: () => void
  allowClose?: boolean
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true }: Props) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [mode, setMode] = useState<'standard' | 'swarm'>('standard')
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmGoal, setSwarmGoal] = useState('')
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(createDefaultSwarmRoleCounts())

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
      agentCount: countSwarmAgents(swarmRoleCounts),
      roleCounts: swarmRoleCounts,
      skills: createDefaultSwarmSkills(),
    }),
    [swarmGoal, swarmRoleCounts]
  )

  const handlePick = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setFolderPath(dir)
    if (!nameTouched) setName(basename(dir) || 'workspace')
  }

  const applyPreset = (roleCounts: SwarmRoleCounts) => {
    setSwarmRoleCounts(roleCounts)
  }

  const adjustRoleCount = (role: SwarmRole, delta: number) => {
    setSwarmRoleCounts((current) => {
      const minimum = role === 'architect' ? 1 : 0
      return {
        ...current,
        [role]: Math.max(minimum, current[role] + delta),
      }
    })
  }

  const handleCreate = () => {
    if (!canCreate) return
    const swarmState = mode === 'swarm' ? undefined : null
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    onCreate({ template, name: name.trim(), folderPath, swarmState })
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
                      <div className="mb-4 flex items-center justify-between gap-4">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                            Team Composition
                          </div>
                          <div className="mt-1 text-sm text-zinc-300">
                            Choose specialist roles instead of selecting skills manually.
                          </div>
                        </div>
                        <div className="text-xs text-zinc-500">
                          {countSwarmAgents(swarmRoleCounts)} total agents
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        {swarmTeamPresets.map((preset) => {
                          const isSelected = roleCountsEqual(swarmRoleCounts, preset.roleCounts)
                          return (
                            <button
                              key={preset.id}
                              onClick={() => applyPreset(preset.roleCounts)}
                              className={`rounded-2xl border p-4 text-left transition-colors ${
                                isSelected
                                  ? 'border-[#4d4d51] bg-[#191c21]'
                                  : 'border-[#23262d] bg-[#101216] hover:border-[#2f3540] hover:bg-[#13161b]'
                              }`}
                            >
                              <div className="text-sm font-semibold text-zinc-100">{preset.name}</div>
                              <div className="mt-1 text-[12px] leading-5 text-zinc-500">{preset.description}</div>
                              <div className="mt-4">
                                <RoleBubbleRow roleCounts={preset.roleCounts} />
                              </div>
                            </button>
                          )
                        })}
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {(['architect', 'developer', 'frontend', 'tester', 'security'] as SwarmRole[]).map((role) => (
                          <div
                            key={role}
                            className="rounded-xl border border-[#23262d] bg-[#101216] px-4 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <span
                                  className="h-3 w-3 shrink-0 rounded-full"
                                  style={{
                                    backgroundColor: swarmRoleAccent[role],
                                    boxShadow: `0 0 16px ${swarmRoleAccent[role]}`,
                                  }}
                                />
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-zinc-100">
                                    {swarmRoleLabels[role]}
                                  </div>
                                  <div className="text-[11px] text-zinc-500">Preconfigured specialist</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => adjustRoleCount(role, -1)}
                                  disabled={role === 'architect' && swarmRoleCounts[role] <= 1}
                                  className="h-8 w-8 rounded-lg border border-[#2d3139] bg-[#171a20] text-zinc-300 transition-colors hover:bg-[#1f232b] disabled:opacity-40 disabled:hover:bg-[#171a20]"
                                >
                                  -
                                </button>
                                <div className="w-8 text-center text-sm font-semibold text-zinc-100">
                                  {swarmRoleCounts[role]}
                                </div>
                                <button
                                  onClick={() => adjustRoleCount(role, 1)}
                                  className="h-8 w-8 rounded-lg border border-[#2d3139] bg-[#171a20] text-zinc-300 transition-colors hover:bg-[#1f232b]"
                                >
                                  +
                                </button>
                              </div>
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
                          {countSwarmAgents(swarmRoleCounts)} agents
                        </span>
                      </div>
                      <SwarmCreatePreview goal={swarmGoal} roleCounts={swarmRoleCounts} />
                    </div>

                    <div className="rounded-2xl border border-[#23262d] bg-[#14161a] p-4">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                        What Opens
                      </div>
                      <ul className="space-y-2 text-sm leading-6 text-zinc-300">
                        <li>Central kanban board with live task creation and progress.</li>
                        <li>Task detail modal on click for ownership, evidence, and implementation details.</li>
                        <li>Right-side specialist CLI panes for each configured role.</li>
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
  roleCounts,
}: {
  goal: string
  roleCounts: SwarmRoleCounts
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
            {['Todo', 'Ready', 'In Progress'].map((lane, index) => (
              <div key={lane} className="rounded-lg border border-[#23262d] bg-[#101216] p-2">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">{lane}</div>
                <div className={`rounded-md p-2 text-[11px] leading-5 ${
                  index === 1 ? 'bg-sky-950/40 text-sky-200' : index === 2 ? 'bg-amber-950/40 text-amber-200' : 'bg-[#181b20] text-zinc-300'
                }`}>
                  {index === 0 && 'Architect writes low-level design'}
                  {index === 1 && 'Developer claims execution task'}
                  {index === 2 && 'Frontend designer updates board UX'}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-[#23262d] bg-[#14161a] p-3">
            <div className="mb-2 text-xs font-semibold text-zinc-200">Specialist Roles</div>
            <div className="mb-3 text-[11px] text-zinc-500">
              Preconfigured specialists with role-specific prompts and skills.
            </div>
            <div className="space-y-2">
              {roleBadgeSummary(roleCounts).map(({ role, count }) => (
                <div key={role} className="rounded-lg border border-[#23262d] bg-[#101216] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: swarmRoleAccent[role], boxShadow: `0 0 12px ${swarmRoleAccent[role]}` }}
                      />
                      <div className="text-[11px] font-medium text-zinc-100">{swarmRoleLabels[role]}</div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                      {count}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-[#23262d] bg-[#14161a] p-3">
            <div className="mb-2 text-xs font-semibold text-zinc-200">Team Footprint</div>
            <RoleBubbleRow roleCounts={roleCounts} />
          </div>
        </div>
      </div>
    </div>
  )
}

function roleCountsEqual(a: SwarmRoleCounts, b: SwarmRoleCounts): boolean {
  return (
    a.architect === b.architect
    && a.developer === b.developer
    && a.frontend === b.frontend
    && a.tester === b.tester
    && a.security === b.security
  )
}

function roleBadgeSummary(roleCounts: SwarmRoleCounts): Array<{ role: SwarmRole; count: number }> {
  return (Object.entries(roleCounts) as Array<[SwarmRole, number]>)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => ({ role, count }))
}

function RoleBubbleRow({ roleCounts }: { roleCounts: SwarmRoleCounts }) {
  const roles = roleBadgeSummary(roleCounts)

  return (
    <div className="flex flex-wrap gap-2">
      {roles.flatMap(({ role, count }) =>
        Array.from({ length: count }, (_, index) => (
          <div
            key={`${role}-${index}`}
            className="inline-flex items-center gap-2 rounded-full border border-[#2a2e36] bg-[#111318] px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-zinc-200"
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: swarmRoleAccent[role], boxShadow: `0 0 12px ${swarmRoleAccent[role]}` }}
            />
            {role === 'architect'
              ? 'A'
              : role === 'developer'
                ? 'D'
                : role === 'frontend'
                  ? 'UX'
                  : role === 'security'
                    ? 'SEC'
                    : 'T'}
          </div>
        ))
      )}
    </div>
  )
}
