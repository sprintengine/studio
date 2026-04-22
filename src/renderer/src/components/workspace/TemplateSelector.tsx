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
import { getSwarmStateFilePath, parseSwarmStateFile } from '../../utils/swarmStateFile'

type ExistingTeam = {
  slug: string
  state: SwarmState
}

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
  const [existingTeams, setExistingTeams] = useState<ExistingTeam[]>([])
  const [selectedExistingTeam, setSelectedExistingTeam] = useState<ExistingTeam | null>(null)
  const [isScanning, setIsScanning] = useState(false)

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
    && (mode === 'standard' || selectedExistingTeam != null || (swarmTeamName.trim().length > 0 && swarmGoal.trim().length > 0 && totalAgents > 0))

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
    setSelectedExistingTeam(null)
    if (!nameTouched) setName(basename(dir) || 'workspace')
    if (!swarmTeamNameTouched) setSwarmTeamName(toTitleName(basename(dir)) || 'Swarm Team')

    setIsScanning(true)
    try {
      const entries = await window.api.readdir(`${dir}/swarm`).catch(() => [])
      const teams: ExistingTeam[] = []
      for (const entry of entries) {
        if (!entry.isDir) continue
        try {
          const content = await window.api.readfile(getSwarmStateFilePath(dir, entry.name))
          teams.push({ slug: entry.name, state: parseSwarmStateFile(content) })
        } catch { /* not a valid team */ }
      }
      setExistingTeams(teams)
    } finally {
      setIsScanning(false)
    }
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
    if (selectedExistingTeam) {
      const { state } = selectedExistingTeam
      const template = createSwarmTemplate({ name: state.name, goal: state.goal, roleCounts: state.roleCounts })
      onCreate({ template, name: name.trim(), folderPath, swarmState: state })
      return
    }
    const swarmState = mode === 'swarm' ? createInitialSwarmState(swarmConfig) : null
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    onCreate({ template, name: name.trim(), folderPath, swarmState })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#08090b] text-[#ececee]">
      <header className="shrink-0 border-b border-[#1f2025] bg-[#0d0e11] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Workspace</div>
            <h1 className="m-0 mt-1 text-[24px] font-semibold text-[#ececee]">Create Workspace</h1>
          </div>
          <div className="flex items-center gap-2">
            {allowClose ? (
              <button
                onClick={onClose}
                className="h-9 rounded-md border border-[#303139] bg-[#111216] px-3 text-sm font-medium text-[#d7d7dc] transition-colors hover:border-[#3a3b44] hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
            ) : null}
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="h-9 rounded-md border border-[#6ee7d8]/50 bg-[#6ee7d8] px-4 text-sm font-semibold text-[#061210] transition-colors hover:bg-[#9af4ea] disabled:opacity-40 disabled:hover:bg-[#6ee7d8]"
            >
              {selectedExistingTeam ? 'Load Team' : mode === 'swarm' ? 'Create Swarm' : 'Create Workspace'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_190px_minmax(260px,0.9fr)]">
          <div className="min-w-0 rounded-lg border border-[#24252b] bg-[#111216] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Folder</div>
            <div className="mt-1 truncate font-mono text-[13px] text-[#d7d7dc]">
              {folderPath ?? 'No folder selected'}
            </div>
          </div>
          <button
            onClick={handlePick}
            className="h-full min-h-[56px] rounded-lg border border-[#303139] bg-[#111216] px-4 text-sm font-semibold text-[#d7d7dc] transition-colors hover:border-[#3a3b44] hover:bg-[#17181d] hover:text-[#ececee]"
          >
            Choose Folder
          </button>
          <label className="min-w-0 rounded-lg border border-[#24252b] bg-[#111216] px-3 py-2">
            <span className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Workspace Name</span>
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
              className="mt-1 block w-full border-0 bg-transparent font-mono text-[13px] text-[#ececee] outline-none placeholder:text-[#5a5a63]"
            />
          </label>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-[#1f2025] bg-[#0d0e11] px-5 py-2">
        {[
          { id: 'standard' as const, label: 'Standard' },
          { id: 'swarm' as const, label: 'Swarm Mode' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMode(tab.id)}
            className={`h-8 rounded-md px-3 text-sm font-medium transition-colors ${
              mode === tab.id
                ? 'bg-[#111216] text-[#ececee] shadow-[inset_0_-2px_0_#30d158]'
                : 'text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
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
                  <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">IDE Layout</div>
                  <div className="mt-1 text-sm text-[#9a9aa2]">Choose the panes that should open first.</div>
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
                          ? 'border-[#30d158]/55 bg-[#30d158]/10'
                          : 'border-[#24252b] bg-[#111216] hover:border-[#303139] hover:bg-[#17181d]'
                      }`}
                    >
                      <div className="rounded-md border border-[#24252b] bg-[#08090b] p-3">
                        <LayoutPreview slots={template.previewSlots} />
                      </div>
                      <div className="mt-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold text-[#ececee]">{template.name}</div>
                          <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[#9a9aa2]">
                            {template.description}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-md border border-[#303139] bg-[#0d0e11] px-2 py-1 text-[11px] font-semibold text-[#d7d7dc]">
                          {agentCountLabel(template.previewSlots)}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>

            <aside className="rounded-lg border border-[#24252b] bg-[#111216] p-4">
              <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Selected</div>
              <h2 className="mt-2 text-[20px] font-semibold text-[#ececee]">{selected.name}</h2>
              <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">{selected.description}</p>
              <div className="mt-5 rounded-md border border-[#1f2025] bg-[#08090b] p-4">
                <LayoutPreview slots={selected.previewSlots} large />
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid min-h-full gap-4 p-5 xl:grid-cols-[minmax(420px,1fr)_minmax(360px,0.95fr)]">

            {(isScanning || existingTeams.length > 0) ? (
              <div className="col-span-full">
                <div className="mb-3 text-[11px] font-semibold uppercase text-[#9a9aa2]">
                  {isScanning ? 'Scanning for existing teams…' : 'Existing Teams'}
                </div>
                {!isScanning && (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {existingTeams.map((team) => {
                      const selected = selectedExistingTeam?.slug === team.slug
                      const done = team.state.tasks.filter((t) => t.status === 'done').length
                      const running = Object.values(team.state.swarmAgents).some(
                        (agent) => agent.status === 'running' || agent.status === 'needs_input'
                      )
                      const complete = team.state.tasks.length > 0 && done === team.state.tasks.length
                      const phaseLabel = complete ? 'Complete' : running ? 'Running' : team.state.tasks.length > 0 ? 'Tasked' : 'Planning'
                      return (
                        <button
                          key={team.slug}
                          onClick={() => setSelectedExistingTeam(selected ? null : team)}
                          className={`rounded-xl border p-4 text-left transition-colors ${
                            selected
                              ? 'border-[#30d158]/55 bg-[#30d158]/10'
                              : 'border-[#24252b] bg-[#111216] hover:border-[#303139] hover:bg-[#17181d]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-[#ececee]">{team.state.name}</div>
                              <div className="mt-0.5 font-mono text-[11px] text-[#9a9aa2]">{team.slug}</div>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                              running
                                ? 'bg-[#30d158]/15 text-[#b9f7c8]'
                                : complete
                                  ? 'bg-[#30d158]/10 text-[#d4ffdc]'
                                  : 'bg-[#1a1b20] text-[#9a9aa2]'
                            }`}>
                              {phaseLabel}
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-[#9a9aa2]">
                            {team.state.goal || 'No goal set'}
                          </p>
                          <div className="mt-3 flex gap-3 text-[11px] text-[#5a5a63]">
                            <span>{team.state.tasks.length} tasks</span>
                            <span>{done} done</span>
                            <span>{Object.keys(team.state.swarmAgents).length} agents</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
                {!isScanning && !selectedExistingTeam && (
                  <div className="mt-4 border-t border-[#1f2025] pt-4 text-[11px] font-semibold uppercase text-[#9a9aa2]">
                    Or create new
                  </div>
                )}
              </div>
            ) : null}

            {!selectedExistingTeam && <section className="min-w-0 col-span-full xl:col-span-1">
              <div className="mb-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
                <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Swarm Objective</div>
                <div className="mt-1 text-sm text-[#9a9aa2]">Name the team and put the mission where every specialist will see it.</div>
                <label className="mt-4 block">
                  <span className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Team Name</span>
                  <input
                    value={swarmTeamName}
                    onChange={(event) => {
                      setSwarmTeamName(event.target.value)
                      setSwarmTeamNameTouched(true)
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && handleCreate()}
                    placeholder="Interface Rescue Team"
                    className="mt-2 block h-10 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#30d158]/60"
                  />
                </label>
                <label className="mt-4 block">
                  <span className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Goal</span>
                  <textarea
                    value={swarmGoal}
                    onChange={(event) => setSwarmGoal(event.target.value)}
                    placeholder="Describe the outcome this swarm should deliver..."
                    className="mt-2 min-h-[190px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-3 text-[15px] leading-7 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#30d158]/60"
                  />
                </label>
              </div>
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Team</div>
                  <div className="mt-1 text-sm text-[#9a9aa2]">{totalAgents} agents in this workspace.</div>
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-[#24252b] bg-[#111216]">
                {ROLES.map((role) => {
                  const selectedRoleRow = role === selectedRole
                  return (
                    <div
                      key={role}
                      onClick={() => setSelectedRole(role)}
                      className={`flex w-full items-center gap-3 border-b border-[#1f2025] px-3 py-3 text-left last:border-b-0 transition-colors ${
                        selectedRoleRow ? 'bg-[#1a1b20]' : 'hover:bg-[#17181d]'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: swarmRoleAccent[role] }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-[#ececee]">
                          {swarmRoleLabels[role]}
                        </span>
                        <span className="mt-1 block truncate text-[12px] text-[#9a9aa2]">
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
                          className={`flex h-7 w-7 items-center justify-center rounded-md border border-[#303139] bg-[#0d0e11] text-[#d7d7dc] ${
                            role === 'architect' && swarmRoleCounts[role] <= 1
                              ? 'opacity-35'
                              : 'hover:bg-[#17181d]'
                          }`}
                        >
                          -
                        </button>
                        <span className="min-w-8 text-center text-sm font-semibold text-[#ececee]">
                          {swarmRoleCounts[role]}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            adjustRoleCount(role, 1)
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-[#303139] bg-[#0d0e11] text-[#d7d7dc] hover:bg-[#17181d]"
                        >
                          +
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>}

            {selectedExistingTeam ? null : <aside className="min-w-0 rounded-lg border border-[#24252b] bg-[#111216]">
              <div className="border-b border-[#1f2025] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Specialist</div>
                    <h2 className="mt-1 truncate text-[20px] font-semibold text-[#ececee]">
                      {swarmRoleLabels[selectedRole]}
                    </h2>
                  </div>
                  <div className="rounded-md border border-[#303139] bg-[#0d0e11] px-2.5 py-1 text-sm font-semibold text-[#d7d7dc]">
                    {activeRoleCount}
                  </div>
                </div>
                <p className="mt-2 text-sm leading-6 text-[#9a9aa2]">{roleSummaries[selectedRole]}</p>
              </div>

              <div className="space-y-4 p-4">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase text-[#9a9aa2]">Skills</span>
                  <textarea
                    value={roleSkills[selectedRole].join('\n')}
                    onChange={(event) => updateRoleSkills(selectedRole, event.target.value)}
                    className="mt-2 min-h-[128px] w-full resize-none rounded-md border border-[#1f2025] bg-[#0d0e11] px-3 py-2 font-mono text-[12px] leading-5 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#30d158]/60"
                  />
                </label>
                <p className="text-[12px] leading-5 text-[#9a9aa2]">
                  Role prompts are now loaded automatically from the swarm tool when an agent joins.
                  Run <code className="rounded bg-[#0d0e11] px-1 py-0.5 font-mono text-[11px] text-[#6ee7d8]">swarm join --role {selectedRole} --id {selectedRole}-1</code> to start this specialist.
                </p>
              </div>
            </aside>}
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
    explorer: { fill: '#111216', stroke: '#ffa600', text: '#ffd58a' },
    editor: { fill: '#111216', stroke: '#30d158', text: '#b9f7c8' },
    agent: { fill: '#111216', stroke: '#6ee7d8', text: '#bff7f1' },
  }

  return (
    <svg
      viewBox="0 0 300 110"
      preserveAspectRatio="xMidYMid meet"
      className={`block w-full ${large ? 'h-[150px]' : 'h-[104px]'}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="300" height="110" rx="8" fill="#08090b" />
      <rect x="4" y="4" width="292" height="102" rx="6" fill="none" stroke="#24252b" />
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
