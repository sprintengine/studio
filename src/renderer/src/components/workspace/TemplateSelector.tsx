import React, { useEffect, useMemo, useState } from 'react'
import { createSwarmTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import type {
  LayoutTemplate,
  PreviewSlot,
  SwarmMockConfig,
  SwarmRole,
  SwarmRoleCounts,
  SwarmSkillMap,
  SwarmState,
} from '../../types/workspace'
import {
  countSwarmAgents,
  createDefaultSwarmRoleCounts,
  createDefaultSwarmSkills,
  createInitialSwarmState,
  swarmRoleAccent,
  swarmRoleLabels,
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

const ROLES: SwarmRole[] = ['architect', 'product', 'developer', 'frontend', 'tester', 'security']

const roleSummaries: Record<SwarmRole, string> = {
  architect: 'Plans the run, decomposes tasks, and gates execution readiness.',
  product: 'Clarifies audience, positioning, adoption risk, and priority tradeoffs.',
  developer: 'Ships scoped implementation work and integration changes.',
  frontend: 'Owns interaction design, visual quality, responsive layout, and UI polish.',
  tester: 'Validates behavior, regression risk, and acceptance criteria.',
  security: 'Reviews trust boundaries, command safety, data handling, and hardening.',
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function toTitleName(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function cleanLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true }: Props) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [swarmTeamName, setSwarmTeamName] = useState('')
  const [swarmTeamNameTouched, setSwarmTeamNameTouched] = useState(false)
  const [mode, setMode] = useState<'standard' | 'swarm'>('swarm')
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmGoal, setSwarmGoal] = useState('')
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(createDefaultSwarmRoleCounts())
  const [selectedRole, setSelectedRole] = useState<SwarmRole>('architect')
  const [roleSkills, setRoleSkills] = useState<SwarmSkillMap>(createDefaultSwarmSkills())

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && allowClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose])

  const selected = LAYOUT_TEMPLATES.find((template) => template.id === selectedId) ?? LAYOUT_TEMPLATES[0]
  const activeRoleCount = swarmRoleCounts[selectedRole]
  const totalAgents = countSwarmAgents(swarmRoleCounts)
  const canCreate =
    name.trim().length > 0
    && (mode === 'standard' || (swarmTeamName.trim().length > 0 && swarmGoal.trim().length > 0 && totalAgents > 0))

  const swarmConfig = useMemo<SwarmMockConfig>(
    () => ({
      name: swarmTeamName.trim() || name.trim() || 'Swarm Team',
      goal: swarmGoal.trim(),
      roleCounts: swarmRoleCounts,
    }),
    [name, swarmGoal, swarmRoleCounts, swarmTeamName]
  )

  const handlePick = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setFolderPath(dir)
    if (!nameTouched) setName(basename(dir) || 'workspace')
    if (!swarmTeamNameTouched) setSwarmTeamName(toTitleName(basename(dir)) || 'Swarm Team')
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

  const updateRoleSkills = (role: SwarmRole, value: string) => {
    setRoleSkills((current) => ({
      ...current,
      [role]: cleanLines(value),
    }))
  }

  const handleCreate = () => {
    if (!canCreate) return
    const swarmState = mode === 'swarm' ? createInitialSwarmState(swarmConfig) : null
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    onCreate({ template, name: name.trim(), folderPath, swarmState })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0b0d10] text-zinc-100">
      <header className="shrink-0 border-b border-[#222833] bg-[#0f1217] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase text-[#8892a6]">Workspace</div>
            <h1 className="m-0 mt-1 text-[24px] font-semibold text-[#f2f5f9]">Create Workspace</h1>
          </div>
          <div className="flex items-center gap-2">
            {allowClose ? (
              <button
                onClick={onClose}
                className="h-9 rounded-md border border-[#28303d] bg-[#131821] px-3 text-sm font-medium text-[#b8c0cf] transition-colors hover:border-[#3a4454] hover:bg-[#18202b] hover:text-white"
              >
                Cancel
              </button>
            ) : null}
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="h-9 rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea] disabled:opacity-40 disabled:hover:bg-[#6ee7d8]"
            >
              {mode === 'swarm' ? 'Create Swarm' : 'Create Workspace'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_190px_minmax(260px,0.9fr)]">
          <div className="min-w-0 rounded-lg border border-[#222833] bg-[#11161d] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[#778196]">Folder</div>
            <div className="mt-1 truncate font-mono text-[13px] text-[#dbe1ea]">
              {folderPath ?? 'No folder selected'}
            </div>
          </div>
          <button
            onClick={handlePick}
            className="h-full min-h-[56px] rounded-lg border border-[#2b3442] bg-[#141a23] px-4 text-sm font-semibold text-[#d7deea] transition-colors hover:border-[#435064] hover:bg-[#19212c]"
          >
            Choose Folder
          </button>
          <label className="min-w-0 rounded-lg border border-[#222833] bg-[#11161d] px-3 py-2">
            <span className="text-[11px] font-semibold uppercase text-[#778196]">Workspace Name</span>
            <input
              value={name}
              onChange={(event) => {
                const nextName = event.target.value
                setName(nextName)
                setNameTouched(true)
                if (mode === 'swarm' && !swarmTeamNameTouched) {
                  setSwarmTeamName(toTitleName(nextName))
                }
              }}
              onKeyDown={(event) => event.key === 'Enter' && handleCreate()}
              placeholder="my-workspace"
              className="mt-1 block w-full border-0 bg-transparent font-mono text-[13px] text-[#f2f5f9] outline-none placeholder:text-[#5f6878]"
            />
          </label>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-[#202631] bg-[#0d1015] px-5 py-2">
        {[
          { id: 'standard' as const, label: 'Standard' },
          { id: 'swarm' as const, label: 'Swarm Mode' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            className={`h-8 rounded-md px-3 text-sm font-medium transition-colors ${
              mode === tab.id
                ? 'bg-[#e8edf5] text-[#10151d]'
                : 'text-[#8d96a8] hover:bg-[#151a22] hover:text-[#dbe1ea]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <main className="min-h-0 flex-1 overflow-auto">
        {mode === 'standard' ? (
          <div className="grid min-h-full gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="min-w-0">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase text-[#778196]">IDE Layout</div>
                  <div className="mt-1 text-sm text-[#a8b2c3]">Choose the panes that should open first.</div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {LAYOUT_TEMPLATES.map((template) => {
                  const isSelected = template.id === selectedId
                  return (
                    <button
                      key={template.id}
                      onClick={() => setSelectedId(template.id)}
                      className={`group flex min-h-[188px] flex-col rounded-lg border p-3 text-left transition-colors focus:outline-none ${
                        isSelected
                          ? 'border-[#6ee7d8]/60 bg-[#14202a]'
                          : 'border-[#222833] bg-[#11161d] hover:border-[#384456] hover:bg-[#141a23]'
                      }`}
                    >
                      <div className="rounded-md border border-[#1d232d] bg-[#080a0d] p-3">
                        <LayoutPreview slots={template.previewSlots} />
                      </div>
                      <div className="mt-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold text-[#f2f5f9]">{template.name}</div>
                          <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[#8d96a8]">
                            {template.description}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-md border border-[#2a323f] bg-[#0d1117] px-2 py-1 text-[11px] font-semibold text-[#aeb7c7]">
                          {agentCountLabel(template.previewSlots)}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>

            <aside className="rounded-lg border border-[#222833] bg-[#11161d] p-4">
              <div className="text-[11px] font-semibold uppercase text-[#778196]">Selected</div>
              <h2 className="mt-2 text-[20px] font-semibold text-[#f2f5f9]">{selected.name}</h2>
              <p className="mt-2 text-sm leading-6 text-[#a8b2c3]">{selected.description}</p>
              <div className="mt-5 rounded-md border border-[#202631] bg-[#090c10] p-4">
                <LayoutPreview slots={selected.previewSlots} large />
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid min-h-full gap-4 p-5 xl:grid-cols-[minmax(420px,1fr)_minmax(360px,0.95fr)]">

            <section className="min-w-0">
              <div className="mb-4 rounded-lg border border-[#2d3746] bg-[#111820] p-4">
                <div className="text-[11px] font-semibold uppercase text-[#778196]">Swarm Objective</div>
                <div className="mt-1 text-sm text-[#a8b2c3]">Name the team and put the mission where every specialist will see it.</div>
                <label className="mt-4 block">
                  <span className="text-[11px] font-semibold uppercase text-[#778196]">Team Name</span>
                  <input
                    value={swarmTeamName}
                    onChange={(event) => {
                      setSwarmTeamName(event.target.value)
                      setSwarmTeamNameTouched(true)
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && handleCreate()}
                    placeholder="Interface Rescue Team"
                    className="mt-2 block h-10 w-full rounded-md border border-[#26303d] bg-[#0b0f14] px-3 text-sm font-semibold text-[#f2f5f9] outline-none transition-colors placeholder:text-[#5f6878] focus:border-[#435064]"
                  />
                </label>
                <label className="mt-4 block">
                  <span className="text-[11px] font-semibold uppercase text-[#778196]">Goal</span>
                  <textarea
                    value={swarmGoal}
                    onChange={(event) => setSwarmGoal(event.target.value)}
                    placeholder="Describe the outcome this swarm should deliver..."
                    className="mt-2 min-h-[190px] w-full resize-none rounded-md border border-[#26303d] bg-[#0b0f14] px-3 py-3 text-[15px] leading-7 text-[#f2f5f9] outline-none transition-colors placeholder:text-[#5f6878] focus:border-[#435064]"
                  />
                </label>
              </div>
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase text-[#778196]">Team</div>
                  <div className="mt-1 text-sm text-[#a8b2c3]">{totalAgents} agents in this workspace.</div>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-[#222833] bg-[#11161d]">
                {ROLES.map((role) => {
                  const selectedRoleRow = role === selectedRole
                  return (
                    <div
                      key={role}
                      onClick={() => setSelectedRole(role)}
                      className={`flex w-full items-center gap-3 border-b border-[#202631] px-3 py-3 text-left last:border-b-0 transition-colors ${
                        selectedRoleRow ? 'bg-[#16212b]' : 'hover:bg-[#141a23]'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: swarmRoleAccent[role] }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-[#f2f5f9]">
                          {swarmRoleLabels[role]}
                        </span>
                        <span className="mt-1 block truncate text-[12px] text-[#8d96a8]">
                          {roleSummaries[role]}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            adjustRoleCount(role, -1)
                          }}
                          disabled={role === 'architect' && swarmRoleCounts[role] <= 1}
                          className={`flex h-7 w-7 items-center justify-center rounded-md border border-[#2a323f] bg-[#0e131a] text-[#c5cedd] ${
                            role === 'architect' && swarmRoleCounts[role] <= 1
                              ? 'opacity-35'
                              : 'hover:bg-[#18202b]'
                          }`}
                        >
                          -
                        </button>
                        <span className="min-w-8 text-center text-sm font-semibold text-[#f2f5f9]">
                          {swarmRoleCounts[role]}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            adjustRoleCount(role, 1)
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#2a323f] bg-[#0e131a] text-[#c5cedd] hover:bg-[#18202b]"
                        >
                          +
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>

            <aside className="min-w-0 rounded-lg border border-[#222833] bg-[#11161d]">
              <div className="border-b border-[#202631] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase text-[#778196]">Specialist</div>
                    <h2 className="mt-1 truncate text-[20px] font-semibold text-[#f2f5f9]">
                      {swarmRoleLabels[selectedRole]}
                    </h2>
                  </div>
                  <div className="rounded-md border border-[#2a323f] bg-[#0d1117] px-2.5 py-1 text-sm font-semibold text-[#dbe1ea]">
                    {activeRoleCount}
                  </div>
                </div>
                <p className="mt-2 text-sm leading-6 text-[#a8b2c3]">{roleSummaries[selectedRole]}</p>
              </div>

              <div className="space-y-4 p-4">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase text-[#778196]">Skills</span>
                  <textarea
                    value={roleSkills[selectedRole].join('\n')}
                    onChange={(event) => updateRoleSkills(selectedRole, event.target.value)}
                    className="mt-2 min-h-[128px] w-full resize-none rounded-md border border-[#202631] bg-[#0b0f14] px-3 py-2 font-mono text-[12px] leading-5 text-[#e7ecf4] outline-none transition-colors placeholder:text-[#5f6878] focus:border-[#435064]"
                  />
                </label>
                <p className="text-[12px] leading-5 text-[#8d96a8]">
                  Role prompts are now loaded automatically from the swarm tool when an agent joins.
                  Run <code className="rounded bg-[#0b0f14] px-1 py-0.5 font-mono text-[11px] text-[#6ee7d8]">swarm join --role {selectedRole} --id {selectedRole}-1</code> to start this specialist.
                </p>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}

function agentCountLabel(slots: PreviewSlot[]): string {
  const n = slots.filter((slot) => slot.type === 'agent').length
  return n === 1 ? '1 agent' : `${n} agents`
}

function LayoutPreview({ slots, large = false }: { slots: PreviewSlot[]; large?: boolean }) {
  const style: Record<PreviewSlot['type'], { fill: string; stroke: string; text: string }> = {
    explorer: { fill: '#1b2430', stroke: '#f6c86b', text: '#f7d997' },
    editor: { fill: '#16261e', stroke: '#77e6a0', text: '#b7f2c8' },
    agent: { fill: '#132234', stroke: '#78b7ff', text: '#b9d7ff' },
  }

  return (
    <svg
      viewBox="0 0 300 110"
      preserveAspectRatio="xMidYMid meet"
      className={`block w-full ${large ? 'h-[150px]' : 'h-[104px]'}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="300" height="110" rx="8" fill="#0c1016" />
      <rect x="4" y="4" width="292" height="102" rx="6" fill="none" stroke="#1f2733" />
      {slots.map((slot, index) => {
        const c = style[slot.type]
        return (
          <g key={index}>
            <rect
              x={slot.x}
              y={slot.y}
              width={slot.w}
              height={slot.h}
              rx="5"
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth="1"
            />
            <text
              x={slot.x + slot.w / 2}
              y={slot.y + slot.h / 2 + 3}
              textAnchor="middle"
              fontSize={slot.w < 70 ? '7' : '8'}
              fontWeight="700"
              fill={c.text}
              fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
            >
              {slot.label.toUpperCase()}
            </text>
          </g>
        )
      })}
    </svg>
  )
}


