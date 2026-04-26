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
  SwarmWorkspaceContext,
} from '../../types/workspace'
import {
  countSwarmAgents,
  createInitialSwarmState,
  swarmRoleLabels,
  swarmRoleOrder,
} from '../../utils/swarm'
import {
  getSwarmDirectoryPath,
  getExistingSwarmStateFilePath,
  getSwarmStateFilePath,
  parseSwarmStateFile,
  slugifySwarmName,
} from '../../utils/swarmStateFile'

type ExistingTeam = {
  slug: string
  displayName: string
  context: SwarmWorkspaceContext
  state: SwarmState
}

type CreationMode = 'swarm' | 'standard'

interface Props {
  onCreate: (args: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    swarmState?: SwarmState | null
    swarmContext?: SwarmWorkspaceContext | null
  }) => void
  onClose: () => void
  allowClose?: boolean
}

const roleSummaries: Record<SwarmRole, string> = {
  architect: 'Turns the objective into a plan, dependencies, and review gates.',
  product: 'Clarifies scope, tradeoffs, user value, and acceptance criteria.',
  frontend: 'Designs and implements responsive UI, interaction states, and polish.',
  developer: 'Builds core logic, integrations, refactors, and production code paths.',
  tester: 'Runs acceptance checks, regression passes, and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, abuse cases, and hardening risks.',
}

const roleAccentClasses: Record<SwarmRole, string> = {
  architect: 'bg-[#ffbf2f]',
  product: 'bg-[#8b5cf6]',
  developer: 'bg-[#30d158]',
  frontend: 'bg-[#6ee7d8]',
  tester: 'bg-[#64a8ff]',
  security: 'bg-[#ff6b6b]',
}

const initialSwarmRoleCounts: SwarmRoleCounts = {
  architect: 1,
  product: 0,
  frontend: 0,
  developer: 0,
  tester: 0,
  security: 0,
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

function buildSwarmContext(folderPath: string, teamName: string, teamSlug: string): SwarmWorkspaceContext {
  return {
    teamName,
    teamSlug,
    teamDirectoryPath: getSwarmDirectoryPath(folderPath, teamSlug),
    statePath: getSwarmStateFilePath(folderPath, teamSlug),
  }
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
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(initialSwarmRoleCounts)
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
          const state = parseSwarmStateFile(content, entry.name)
          const displayName = getExistingTeamDisplayName(entry.name, state)
          teams.push({
            slug: entry.name,
            displayName,
            context: buildSwarmContext(dir, displayName, entry.name),
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
      const { displayName, state, context } = selectedExistingTeam
      const loadedState = { ...state, name: displayName }
      const template = createSwarmTemplate({
        name: loadedState.name,
        goal: loadedState.goal,
        roleCounts: loadedState.roleCounts,
      })
      onCreate({ template, name: name.trim(), folderPath, swarmState: loadedState, swarmContext: context })
      return
    }

    const swarmState = mode === 'swarm' ? createInitialSwarmState(swarmConfig) : null
    const template = mode === 'swarm' ? createSwarmTemplate(swarmConfig) : selected
    const swarmContext = mode === 'swarm' && folderPath && swarmState
      ? buildSwarmContext(folderPath, swarmState.name, slugifySwarmName(swarmState.name))
      : null
    onCreate({ template, name: name.trim(), folderPath, swarmState, swarmContext })
  }

  return (
    <div className="h-full overflow-auto bg-[#08090b] text-[#ececee]">
      <section className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 py-5">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-[#1f2025] pb-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold text-[#ececee]">New Workspace</h1>
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
              className="h-9 rounded-md border border-[#ececee] bg-[#ececee] px-4 text-sm font-semibold text-[#08090b] transition-colors hover:bg-white disabled:border-[#303139] disabled:bg-[#17181d] disabled:text-[#5a5a63]"
            >
              {selectedExistingTeam ? 'Load Team' : mode === 'swarm' ? 'Create Swarm' : 'Create Workspace'}
            </button>
          </div>
        </header>

        <div className="mt-5 min-h-0 flex-1">
          <main className="min-w-0 space-y-4">
            <div className="inline-flex rounded-md bg-[#111216] p-1">
              {[
                { id: 'standard' as const, label: 'Standard' },
                { id: 'swarm' as const, label: 'Swarm' },
              ].map((option) => {
                const active = mode === option.id
                const swarmOption = option.id === 'swarm'
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleModeChange(option.id)}
                    className={`inline-flex h-8 items-center gap-2 rounded border px-3 text-sm font-semibold transition-colors ${
                      active && swarmOption
                        ? 'border-[#3a3426] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(255,191,47,0.42)]'
                        : active
                          ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                          : swarmOption
                            ? 'border-transparent text-[#9a9aa2] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            : 'border-transparent text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {swarmOption ? (
                      <WorkspaceTypeIcon mode="swarm" className="h-3.5 w-3.5 shrink-0 text-[#ffbf2f]" />
                    ) : null}
                    {option.label}
                  </button>
                )
              })}
            </div>

            <section className="border-b border-[#1f2025] pb-5">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">Folder</div>
                  <button
                    type="button"
                    onClick={handlePick}
                    className="flex h-[42px] w-full items-center gap-3 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-left transition-colors hover:bg-[#111216] focus:outline-none focus:ring-2 focus:ring-[#ececee]/25"
                  >
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        folderPath ? 'text-[#d7d7dc]' : 'text-[#5a5a63]'
                      }`}
                    >
                      {folderPath ?? 'Choose folder'}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-[#d7d7dc]">Browse</span>
                  </button>
                </div>

                <label className="flex min-w-0 flex-col gap-2">
                  <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                    Workspace name
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
                    className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                  />
                </label>
              </div>
            </section>

            {mode === 'swarm' ? (
              <>
                <section className="border-b border-[#1f2025] pb-5">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Team name
                      </span>
                      <input
                        value={swarmTeamName}
                        onChange={(event) => {
                          setSelectedExistingTeam(null)
                          setSwarmTeamName(event.target.value)
                          setSwarmTeamNameTouched(true)
                        }}
                        placeholder="Interface Team"
                        className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                      />
                    </label>

                    <label className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Existing team
                      </span>
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
                        className="h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] outline-none transition-colors focus:border-[#ececee]/70 disabled:text-[#5a5a63]"
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
                    </label>
                  </div>

                  <label className="mt-4 block">
                    <span className="text-xs font-medium text-[#9a9aa2]">
                      Objective
                    </span>
                    <textarea
                      value={swarmGoal}
                      onChange={(event) => {
                        setSelectedExistingTeam(null)
                        setSwarmGoal(event.target.value)
                      }}
                      placeholder="Describe the outcome this swarm should deliver..."
                      className="mt-2 min-h-[140px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-3 text-[14px] leading-6 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                    />
                  </label>
                </section>

                <section>
                  <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
                    <div>
                      <div className="mb-3 text-xs font-medium text-[#9a9aa2]">Swarm roles</div>
                      <div className="border-t border-[#303139]">
                        {swarmRoleOrder.map((role) => (
                          <div
                            key={role}
                            className="flex min-h-[68px] items-center border-b border-[#303139] px-3 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <span className={`h-2 w-2 shrink-0 rounded-full ${roleAccentClasses[role]}`} />
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-[#ececee]">
                                  {swarmRoleLabels[role]}
                                </span>
                                <span className="mt-1 block text-[12px] leading-4 text-[#9a9aa2]">
                                  {roleSummaries[role]}
                                </span>
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#24252b] bg-[#0d0e11] p-3">
                      <div className="mb-3 flex items-baseline justify-between gap-4">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#ececee]">Swarm workspace</div>
                          <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                            Project brief, map, task graph, and Kanban
                          </div>
                        </div>
                      </div>
                      <div className="rounded-md border border-[#303139] bg-[#08090b] p-3">
                        <SwarmWorkspacePreview />
                      </div>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <section>
                <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
                  <div>
                    <div className="mb-3 text-xs font-medium text-[#9a9aa2]">
                      IDE layout
                    </div>
                    <div className="border-t border-[#303139]">
                      {LAYOUT_TEMPLATES.map((template) => {
                        const isSelected = template.id === selectedId
                        return (
                          <button
                            key={template.id}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => setSelectedId(template.id)}
                            className={`grid min-h-[64px] w-full grid-cols-[minmax(0,1fr)_18px] items-center gap-4 border-b border-[#303139] px-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-[#ececee]/25 ${
                              isSelected ? 'bg-[#17181d]' : 'hover:bg-[#111216]'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-[#ececee]">{template.name}</div>
                              <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                                {template.description}
                              </div>
                            </div>
                            <span
                              className={`h-4 w-4 rounded-full border ${
                                isSelected ? 'border-[5px] border-[#ececee]' : 'border-[#303139]'
                              }`}
                              aria-hidden="true"
                            />
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-lg border border-[#24252b] bg-[#0d0e11] p-3">
                    <div className="mb-3 flex items-baseline justify-between gap-4">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#ececee]">{selected.name}</div>
                        <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                          {selected.description}
                        </div>
                      </div>
                      <div className="shrink-0 text-[12px] font-medium text-[#9a9aa2]">
                        {agentCountLabel(selected.previewSlots)}
                      </div>
                    </div>
                    <div className="rounded-md border border-[#303139] bg-[#08090b] p-3">
                      <LayoutPreview slots={selected.previewSlots} />
                    </div>
                  </div>
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

function LayoutPreview({ slots }: { slots: PreviewSlot[] }) {
  return (
    <svg
      viewBox="0 0 300 110"
      preserveAspectRatio="xMidYMid meet"
      className="block aspect-[300/110] w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="300" height="110" rx="8" fill="#0d0e11" />
      <WorkspaceChrome />
      <g transform="translate(0 18) scale(1 0.82)">
        {slots.map((slot) => {
          const key = `${slot.type}-${slot.label}-${slot.x}-${slot.y}`

          if (slot.type === 'explorer') return <ExplorerPreview key={key} slot={slot} />
          if (slot.type === 'editor') return <EditorPreview key={key} slot={slot} />

          return <AgentPreview key={key} slot={slot} />
        })}
      </g>
    </svg>
  )
}

function WorkspaceChrome() {
  return (
    <g>
      <rect x="0" y="0" width="300" height="18" rx="8" fill="#08090b" />
      <rect x="8" y="4" width="68" height="11" rx="4" fill="#17181d" stroke="#303139" strokeWidth="0.8" />
      <text x="16" y="12" fill="#d7d7dc" fontSize="5.8" fontWeight="600">
        Workspace
      </text>
      <rect x="80" y="5" width="46" height="9" rx="3.5" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <text x="88" y="11.6" fill="#9a9aa2" fontSize="5.2" fontWeight="600">
        Swarm
      </text>
      <rect x="132" y="5" width="12" height="9" rx="3" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <path d="M138 7.5 V11.5 M136 9.5 H140" stroke="#9a9aa2" strokeWidth="0.9" strokeLinecap="round" />
    </g>
  )
}

function PaneShell({ slot, children }: { slot: PreviewSlot; children: React.ReactNode }) {
  return (
    <g>
      <rect
        x={slot.x}
        y={slot.y}
        width={slot.w}
        height={slot.h}
        rx="5"
        fill="#101116"
        stroke="#3a3b43"
        strokeWidth="1"
      />
      <rect
        x={slot.x + 1}
        y={slot.y + 1}
        width={Math.max(0, slot.w - 2)}
        height="11"
        rx="4"
        fill="#17181d"
      />
      {children}
    </g>
  )
}

function ExplorerPreview({ slot }: { slot: PreviewSlot }) {
  const rows = previewRows(slot.h, 20, 10, 4)

  return (
    <PaneShell slot={slot}>
      <rect x={slot.x + 6} y={slot.y + 6} width="10" height="2" rx="1" fill="#74757d" />
      {rows.map((row) => {
        const y = slot.y + 20 + row * 10
        const width = Math.max(9, Math.min(slot.w - 16, slot.w * (row % 2 === 0 ? 0.62 : 0.48)))
        return (
          <rect
            key={row}
            x={slot.x + 8}
            y={y}
            width={width}
            height="2"
            rx="1"
            fill={row === 0 ? '#b88928' : '#5a5b63'}
          />
        )
      })}
    </PaneShell>
  )
}

function EditorPreview({ slot }: { slot: PreviewSlot }) {
  const rows = previewRows(slot.h, 20, 9, 5)

  return (
    <PaneShell slot={slot}>
      <rect x={slot.x + 7} y={slot.y + 6} width="20" height="2" rx="1" fill="#74757d" />
      {rows.map((row) => {
        const y = slot.y + 20 + row * 9
        const indent = row === 2 || row === 3 ? 7 : 0
        const width = Math.max(14, Math.min(slot.w - 22 - indent, slot.w * (row % 2 === 0 ? 0.66 : 0.46)))
        return (
          <rect
            key={row}
            x={slot.x + 8 + indent}
            y={y}
            width={width}
            height="2"
            rx="1"
            fill={row === 0 ? '#6fbd85' : '#64656d'}
          />
        )
      })}
    </PaneShell>
  )
}

function AgentPreview({ slot }: { slot: PreviewSlot }) {
  const rows = previewRows(slot.h, 21, 9, 4)

  return (
    <PaneShell slot={slot}>
      <circle cx={slot.x + 8} cy={slot.y + 7} r="1.5" fill="#6ee7d8" />
      <rect x={slot.x + 13} y={slot.y + 6} width="18" height="2" rx="1" fill="#74757d" />
      {rows.map((row) => {
        const y = slot.y + 21 + row * 9
        const width = Math.max(12, Math.min(slot.w - 19, slot.w * (row % 2 === 0 ? 0.58 : 0.42)))
        return (
          <g key={row}>
            <rect x={slot.x + 8} y={y} width="4" height="2" rx="1" fill="#6ee7d8" />
            <rect x={slot.x + 16} y={y} width={width} height="2" rx="1" fill="#62636b" />
          </g>
        )
      })}
    </PaneShell>
  )
}

function previewRows(height: number, firstY: number, gap: number, maxRows: number): number[] {
  return Array.from({ length: maxRows }, (_, row) => row).filter((row) => firstY + row * gap + 2 <= height - 6)
}

function SwarmWorkspacePreview() {
  return (
    <svg
      viewBox="0 0 300 110"
      preserveAspectRatio="xMidYMid meet"
      className="block aspect-[300/110] w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="300" height="110" rx="8" fill="#0d0e11" />
      <WorkspaceChrome />
      <rect x="5" y="21" width="290" height="84" rx="5" fill="#101116" stroke="#3a3b43" strokeWidth="1" />
      <rect x="11" y="28" width="32" height="8" rx="3" fill="#17181d" stroke="#303139" strokeWidth="0.8" />
      <rect x="47" y="28" width="24" height="8" rx="3" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <rect x="75" y="28" width="30" height="8" rx="3" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <rect x="109" y="28" width="34" height="8" rx="3" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <rect x="149" y="28" width="15" height="8" rx="3" fill="#111216" stroke="#24252b" strokeWidth="0.8" />

      <path d="M51 53 H91 M118 62 L91 75 M42 76 H75" stroke="#5f6068" strokeWidth="1" />
      <rect x="18" y="45" width="34" height="16" rx="4" fill="#17181d" stroke="#3a3b43" strokeWidth="0.9" />
      <rect x="92" y="45" width="44" height="16" rx="4" fill="#17181d" stroke="#3a3b43" strokeWidth="0.9" />
      <rect x="75" y="72" width="46" height="16" rx="4" fill="#17181d" stroke="#3a3b43" strokeWidth="0.9" />
      <rect x="25" y="52" width="19" height="2" rx="1" fill="#ffbf2f" opacity="0.86" />
      <rect x="100" y="52" width="26" height="2" rx="1" fill="#6ee7d8" opacity="0.88" />
      <rect x="84" y="79" width="24" height="2" rx="1" fill="#6fbd85" opacity="0.88" />

      <g>
        <rect x="154" y="46" width="36" height="45" rx="3" fill="#14151a" stroke="#303139" strokeWidth="0.7" />
        <rect x="198" y="46" width="36" height="45" rx="3" fill="#14151a" stroke="#303139" strokeWidth="0.7" />
        <rect x="242" y="46" width="36" height="45" rx="3" fill="#14151a" stroke="#303139" strokeWidth="0.7" />
        {[51, 62, 75].map((y, index) => (
          <g key={y}>
            <rect x={160 + index * 44} y={y} width="22" height="6" rx="2" fill={index === 0 ? '#3a3426' : '#17181d'} />
            <rect x={160 + index * 44} y={y + 14} width="18" height="6" rx="2" fill="#17181d" />
          </g>
        ))}
      </g>
    </svg>
  )
}
