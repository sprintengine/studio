import React, { useEffect, useMemo, useState } from 'react'
import { createSwarmTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import { WorkspaceTypeIcon } from '../AppIcons'
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
  createInitialSwarmState,
  swarmRoleAccent,
  swarmRoleLabels,
} from '../../utils/swarm'
import {
  getExistingSwarmStateFilePath,
  parseSwarmStateFile,
  slugifySwarmName,
} from '../../utils/swarmStateFile'

type ExistingTeam = {
  slug: string
  displayName: string
  state: SwarmState
}

type CreationMode = 'swarm' | 'standard'

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
  architect: 'Plans the run and gates execution readiness.',
  product: 'Clarifies audience, priority, and tradeoffs.',
  developer: 'Ships implementation and integration changes.',
  frontend: 'Owns interaction, layout, and visual polish.',
  tester: 'Validates behavior and regression risk.',
  security: 'Reviews trust boundaries and command safety.',
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

function getExistingTeamDisplayName(slug: string, state: SwarmState): string {
  const stateName = state.name.trim()
  return slugifySwarmName(stateName) === slug.toLowerCase()
    ? stateName
    : toTitleName(slug)
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true }: Props) {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [mode, setMode] = useState<CreationMode>('standard')
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmTeamName, setSwarmTeamName] = useState('')
  const [swarmTeamNameTouched, setSwarmTeamNameTouched] = useState(false)
  const [swarmGoal, setSwarmGoal] = useState('')
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(createDefaultSwarmRoleCounts())
  const [selectedRole, setSelectedRole] = useState<SwarmRole>('architect')
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
  const totalAgents = countSwarmAgents(swarmRoleCounts)
  const detailsComplete = name.trim().length > 0
  const swarmObjectiveComplete =
    selectedExistingTeam != null || (swarmTeamName.trim().length > 0 && swarmGoal.trim().length > 0)
  const canCreate =
    detailsComplete
    && (mode === 'standard' || selectedExistingTeam != null || (swarmObjectiveComplete && totalAgents > 0))

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

    const folderName = basename(dir)
    setFolderPath(dir)
    setSelectedExistingTeam(null)
    if (!nameTouched) setName(folderName || 'workspace')
    if (!swarmTeamNameTouched) setSwarmTeamName(toTitleName(folderName) || 'Swarm Team')

    setIsScanning(true)
    try {
      const entries = await window.api.readdir(`${dir}/swarm`).catch(() => [])
      const teams: ExistingTeam[] = []
      for (const entry of entries) {
        if (!entry.isDir) continue
        try {
          const content = await window.api.readfile(getExistingSwarmStateFilePath(dir, entry.name))
          const state = parseSwarmStateFile(content)
          teams.push({
            slug: entry.name,
            displayName: getExistingTeamDisplayName(entry.name, state),
            state,
          })
        } catch {
          // Ignore folders that are not swarm state directories.
        }
      }
      setExistingTeams(teams)
    } finally {
      setIsScanning(false)
    }
  }

  const handleModeChange = (nextMode: CreationMode) => {
    setMode(nextMode)
    if (nextMode === 'standard') setSelectedExistingTeam(null)
  }

  const adjustRoleCount = (role: SwarmRole, delta: number) => {
    setSelectedExistingTeam(null)
    setSwarmRoleCounts((current) => {
      const minimum = role === 'architect' ? 1 : 0
      return {
        ...current,
        [role]: Math.max(minimum, current[role] + delta),
      }
    })
  }

  const selectExistingTeam = (team: ExistingTeam) => {
    const isSelected = selectedExistingTeam?.slug === team.slug
    if (isSelected) {
      setSelectedExistingTeam(null)
      return
    }

    setSelectedExistingTeam(team)
    setSwarmTeamName(team.displayName)
    setSwarmGoal(team.state.goal)
    setSwarmRoleCounts(team.state.roleCounts)
    if (!nameTouched) setName(team.displayName)
  }

  const handleCreate = () => {
    if (!canCreate) return

    if (selectedExistingTeam) {
      const { displayName, state } = selectedExistingTeam
      const loadedState = { ...state, name: displayName }
      const template = createSwarmTemplate({
        name: loadedState.name,
        goal: loadedState.goal,
        roleCounts: loadedState.roleCounts,
      })
      onCreate({ template, name: name.trim(), folderPath, swarmState: loadedState })
      return
    }

    const swarmState = mode === 'swarm' ? createInitialSwarmState(swarmConfig) : null
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    onCreate({ template, name: name.trim(), folderPath, swarmState })
  }

  return (
    <div className="h-full overflow-auto bg-[#08090b] text-[#ececee]">
      <section className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-6 py-6">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-[#1f2025] pb-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">Workspace</div>
            <h1 className="mt-1 text-[22px] font-semibold text-[#ececee]">Create Workspace</h1>
          </div>
          <div className="flex items-center gap-2">
            {allowClose ? (
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-md border border-[#303139] bg-[#111216] px-3 text-sm font-medium text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate}
              className="h-9 rounded-md border border-[#ffbf2f]/55 bg-[#ffbf2f] px-4 text-sm font-semibold text-[#161006] shadow-[0_0_18px_rgba(255,191,47,0.12)] transition-colors hover:bg-[#ffd15c] disabled:opacity-40 disabled:hover:bg-[#ffbf2f]"
            >
              {selectedExistingTeam ? 'Load Team' : mode === 'swarm' ? 'Create Swarm' : 'Create Workspace'}
            </button>
          </div>
        </header>

        <div className="mt-5 min-h-0 flex-1">
          <main className="min-w-0 space-y-4">
            <div className="inline-flex rounded-md border border-[#24252b] bg-[#111216] p-1">
              {[
                { id: 'standard' as const, label: 'Standard' },
                { id: 'swarm' as const, label: 'Swarm', premium: true },
              ].map((option) => {
                const active = mode === option.id
                const premiumSwarm = option.id === 'swarm'
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleModeChange(option.id)}
                    className={`inline-flex h-8 items-center gap-2 rounded px-3 text-sm font-semibold transition-colors ${
                      active && premiumSwarm
                        ? 'bg-[#ffbf2f]/12 text-[#ffe0a3] shadow-[inset_0_-2px_0_#ffbf2f]'
                        : active
                          ? 'bg-[#6ee7d8]/12 text-[#bff7f1] shadow-[inset_0_-2px_0_#6ee7d8]'
                          : premiumSwarm
                            ? 'text-[#c7b27c] hover:bg-[#ffbf2f]/8 hover:text-[#ffe0a3]'
                            : 'text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {premiumSwarm ? (
                      <WorkspaceTypeIcon mode="swarm" className="h-3.5 w-3.5 shrink-0 text-[#ffbf2f]" />
                    ) : null}
                    {option.label}
                    {option.premium ? (
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] ${
                          active
                            ? 'border-[#ffbf2f]/35 bg-[#ffbf2f]/10 text-[#ffdf9b]'
                            : 'border-[#6f5520] bg-[#1a140a] text-[#d9b86b]'
                        }`}
                      >
                        Pro
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>

            <section className="rounded-lg border border-[#24252b] bg-[#111216] p-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Folder</div>
                  <div className="mt-2 flex min-h-[42px] items-center gap-3 rounded-md border border-[#303139] bg-[#0d0e11] px-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[#d7d7dc]">
                      {folderPath ?? 'No folder selected'}
                    </span>
                    <button
                      type="button"
                      onClick={handlePick}
                      className="h-8 rounded-md border border-[#303139] bg-[#111216] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                    >
                      Browse
                    </button>
                  </div>
                </div>

                <label className="min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                    Workspace Name
                  </span>
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
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleCreate()
                    }}
                    placeholder="my-workspace"
                    className="mt-2 block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ffbf2f]/65"
                  />
                </label>
              </div>
            </section>

            {mode === 'swarm' ? (
              <>
                <section className="rounded-lg border border-[#24252b] bg-[#111216] p-4">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <label className="min-w-0">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                        Team Name
                      </span>
                      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
                        <input
                          value={swarmTeamName}
                          onChange={(event) => {
                            setSelectedExistingTeam(null)
                            setSwarmTeamName(event.target.value)
                            setSwarmTeamNameTouched(true)
                          }}
                          placeholder="Interface Team"
                          className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ffbf2f]/65"
                        />
                        <select
                          value={selectedExistingTeam?.slug ?? ''}
                          onChange={(event) => {
                            const team = existingTeams.find((candidate) => candidate.slug === event.target.value)
                            if (team) {
                              selectExistingTeam(team)
                            } else {
                              setSelectedExistingTeam(null)
                            }
                          }}
                          disabled={isScanning || existingTeams.length === 0}
                          className="h-[42px] rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] outline-none transition-colors focus:border-[#6ee7d8]/65 disabled:text-[#5a5a63]"
                        >
                          <option value="">
                            {isScanning ? 'Scanning teams...' : existingTeams.length > 0 ? 'Create new team' : 'No existing teams'}
                          </option>
                          {existingTeams.map((team) => (
                            <option key={team.slug} value={team.slug}>
                              {team.displayName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                    <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                        Team Size
                      </div>
                      <div className="mt-1 text-[22px] font-semibold text-[#ececee]">{totalAgents}</div>
                    </div>
                  </div>

                  <label className="mt-4 block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                      Objective
                    </span>
                    <textarea
                      value={swarmGoal}
                      onChange={(event) => {
                        setSelectedExistingTeam(null)
                        setSwarmGoal(event.target.value)
                      }}
                      placeholder="Describe the outcome this swarm should deliver..."
                      className="mt-2 min-h-[168px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-3 text-[14px] leading-6 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ffbf2f]/65"
                    />
                  </label>
                </section>

                <section className="rounded-lg border border-[#24252b] bg-[#111216] p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                      Team Composition
                    </div>
                    <div className="text-[12px] text-[#5a5a63]">{swarmRoleLabels[selectedRole]} selected</div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {ROLES.map((role) => {
                      const selectedRoleRow = role === selectedRole
                      return (
                        <div
                          key={role}
                          onClick={() => setSelectedRole(role)}
                          className={`flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 transition-colors ${
                            selectedRoleRow
                              ? 'border-[#6ee7d8]/45 bg-[#6ee7d8]/10'
                              : 'border-[#24252b] bg-[#0d0e11] hover:border-[#303139] hover:bg-[#17181d]'
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
                            <span className="mt-0.5 block truncate text-[12px] text-[#9a9aa2]">
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
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-[#303139] bg-[#111216] text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:opacity-35"
                              aria-label={`Remove ${swarmRoleLabels[role]}`}
                            >
                              -
                            </button>
                            <span className="min-w-7 text-center text-sm font-semibold text-[#ececee]">
                              {swarmRoleCounts[role]}
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                adjustRoleCount(role, 1)
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-[#303139] bg-[#111216] text-[#d7d7dc] transition-colors hover:bg-[#17181d]"
                              aria-label={`Add ${swarmRoleLabels[role]}`}
                            >
                              +
                            </button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              </>
            ) : (
              <section className="rounded-lg border border-[#24252b] bg-[#111216] p-4">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  IDE Layout
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {LAYOUT_TEMPLATES.map((template) => {
                    const isSelected = template.id === selectedId
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => setSelectedId(template.id)}
                        className={`group flex min-h-[172px] flex-col rounded-lg border p-3 text-left transition-colors focus:outline-none ${
                          isSelected
                            ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/12'
                            : 'border-[#24252b] bg-[#0d0e11] hover:border-[#303139] hover:bg-[#17181d]'
                        }`}
                      >
                        <div className="rounded-md border border-[#24252b] bg-[#08090b] p-3">
                          <LayoutPreview slots={template.previewSlots} />
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-[15px] font-semibold text-[#ececee]">
                            {template.name}
                          </span>
                          <span className="shrink-0 rounded-md border border-[#303139] bg-[#111216] px-2 py-1 text-[11px] font-semibold text-[#d7d7dc]">
                            {agentCountLabel(template.previewSlots)}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}
          </main>
        </div>
      </section>
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
