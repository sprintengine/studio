import React, { useEffect, useMemo, useState } from 'react'
import { createMultiloopTemplate, createSwarmTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import { WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  LayoutTemplate,
  PreviewSlot,
  SwarmMockConfig,
  SwarmRole,
  SwarmAutoState,
  FuturePlanWorkspaceSource,
  SwarmRoleCounts,
  SwarmRoleCliDefaults,
  SwarmState,
  SwarmWorkspaceContext,
} from '../../types/workspace'
import {
  createPlanSourcedSwarmWorkspace,
  PlanSourcedSwarmWorkspaceError,
} from '../../utils/sprintengineWorkspaceCreation'
import {
  createMultiloopWorkspace,
  MultiloopWorkspaceCreationError,
} from '../../utils/multiloopWorkspaceCreation'
import {
  countSwarmAgents,
  createInitialSwarmState,
  swarmRoleLabels,
  swarmRoleOrder,
} from '../../utils/sprintengine'
import {
  getSwarmDirectoryPath,
  getExistingSwarmStateFilePath,
  getSwarmStateFilePath,
  parseSwarmStateFile,
  slugifySwarmName,
} from '../../utils/sprintengineStateFile'
import multiloopSplash from '../../assets/brand/multiloop-splash.png'
import sprintEngineSplash from '../../assets/brand/sprintengine-splash.png'

type ExistingTeam = {
  slug: string
  displayName: string
  context: SwarmWorkspaceContext
  state: SwarmState
}

type CreationMode = 'standard' | 'sprintengine' | 'multiloop'

type MarkdownPlanOption = {
  path: string
  relativePath: string
}

export type TemplateSelectorInitialState = {
  mode?: CreationMode
  folderPath?: string | null
  workspaceName?: string
  futurePlanSource?: FuturePlanWorkspaceSource | null
}

type SwarmAccessState = {
  allowed: boolean
  title: string
  body: string
  action: 'login'
}

interface Props {
  onCreate: (args: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    swarmState?: SwarmState | null
    swarmContext?: SwarmWorkspaceContext | null
    swarmRoleCliDefaults?: SwarmRoleCliDefaults | null
    swarmAutoState?: Partial<SwarmAutoState> | null
  }) => void
  onClose: () => void
  allowClose?: boolean
  initialState?: TemplateSelectorInitialState | null
}

const roleSummaries: Record<SwarmRole, string> = {
  architect: 'Turns the objective into a plan, dependencies, and review gates.',
  product: 'Clarifies scope, tradeoffs, user value, and acceptance criteria.',
  frontend: 'Designs and implements responsive UI, interaction states, and polish.',
  developer: 'Builds core logic, integrations, refactors, and production code paths.',
  code_reviewer: 'Reviews implementation quality, regressions, and evidence before validation.',
  performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps after code review.',
  tester: 'Runs acceptance checks, regression passes, and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, abuse cases, and hardening risks.',
}

const roleAccentClasses: Record<SwarmRole, string> = {
  architect: 'bg-[#ffbf2f]',
  product: 'bg-[#8b5cf6]',
  developer: 'bg-[#30d158]',
  frontend: 'bg-[#6ee7d8]',
  code_reviewer: 'bg-[#f59e0b]',
  performance: 'bg-[#a78bfa]',
  tester: 'bg-[#64a8ff]',
  security: 'bg-[#ff6b6b]',
}

const initialSwarmRoleCounts: SwarmRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  developer: 0,
  code_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
}

const initialSwarmRoleCliDefaults: Required<SwarmRoleCliDefaults> = {
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
}

const cliOptions: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
]

const maxVisibleRecentFolders = 5

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function folderKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() || path
}

function toTitleName(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function pathSeparatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function joinPath(parent: string, child: string): string {
  const separator = pathSeparatorFor(parent)
  return `${parent}${parent.endsWith(separator) ? '' : separator}${child}`
}

function workspaceRelativePath(rootPath: string, filePath: string): string | null {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  const rootKey = normalizedRoot.toLowerCase()
  const fileKey = normalizedFile.toLowerCase()
  if (fileKey === rootKey || !fileKey.startsWith(`${rootKey}/`)) return null
  return normalizedFile.slice(normalizedRoot.length + 1)
}

function planBasename(path: string): string {
  const name = basename(path)
  return name.replace(/\.md$/i, '')
}

function markdownTitle(content: string): string | null {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#(?!#)\s+\S/.test(line))

  return heading?.replace(/^#\s+/, '').trim() || null
}

function shouldScanDirectory(name: string): boolean {
  return name !== 'node_modules' && name !== '.git' && name !== '.multicode-worktrees'
}

async function listMarkdownPlanOptions(rootPath: string): Promise<MarkdownPlanOption[]> {
  const options: MarkdownPlanOption[] = []
  const queue = [rootPath]
  const maxFiles = 500

  while (queue.length > 0 && options.length < maxFiles) {
    const dir = queue.shift()
    if (!dir) break

    const entries = await window.api.readdir(dir).catch(() => [])
    for (const entry of entries) {
      const entryPath = joinPath(dir, entry.name)
      if (entry.isDir) {
        if (shouldScanDirectory(entry.name)) queue.push(entryPath)
        continue
      }

      if (!/\.md$/i.test(entry.name)) continue
      const relativePath = workspaceRelativePath(rootPath, entryPath)
      if (relativePath) options.push({ path: entryPath, relativePath })
      if (options.length >= maxFiles) break
    }
  }

  return options.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
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

function getSwarmAccessState(authState: MulticodeAuthState): SwarmAccessState {
  if (!authState.authenticated) {
    return {
      allowed: false,
      title: 'Sprint Engine mode is locked while signed out.',
      body: 'Sign in to create or supervise local Sprint Engine specialist workflows. Standard workspaces remain available.',
      action: 'login',
    }
  }

  return {
    allowed: true,
    title: 'Sprint Engine mode is available.',
    body: 'This signed-in Multicode session can create local Sprint Engine workflows.',
    action: 'login',
  }
}

export default function TemplateSelector({ onCreate, onClose, allowClose = true, initialState = null }: Props) {
  const authState = useWorkspaceStore((s) => s.authState)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const storedRecentFolders = useWorkspaceStore((s) => s.appSettings.recentWorkspaceFolders ?? [])
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const initialFuturePlan = initialState?.futurePlanSource ?? null
  const [folderPath, setFolderPath] = useState<string | null>(initialState?.folderPath ?? initialFuturePlan?.folderPath ?? null)
  const [name, setName] = useState(initialState?.workspaceName ?? initialFuturePlan?.teamName ?? '')
  const [nameTouched, setNameTouched] = useState(Boolean(initialState?.workspaceName ?? initialFuturePlan))
  const [mode, setMode] = useState<CreationMode>(initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard'))
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmTeamName, setSwarmTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [swarmTeamNameTouched, setSwarmTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [swarmGoal, setSwarmGoal] = useState(initialFuturePlan?.goal ?? '')
  const [multiloopName, setMultiloopName] = useState('')
  const [multiloopNameTouched, setMultiloopNameTouched] = useState(false)
  const [multiloopGoal, setMultiloopGoal] = useState('')
  const [multiloopError, setMultiloopError] = useState<string | null>(null)
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(initialSwarmRoleCounts)
  const [swarmRoleCliDefaults, setSwarmRoleCliDefaults] = useState<Required<SwarmRoleCliDefaults>>(
    initialSwarmRoleCliDefaults
  )
  const [existingTeams, setExistingTeams] = useState<ExistingTeam[]>([])
  const [selectedExistingTeam, setSelectedExistingTeam] = useState<ExistingTeam | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [useWorktreesForSwarms, setUseWorktreesForSwarms] = useState(false)
  const [futurePlanOptions, setFuturePlanOptions] = useState<MarkdownPlanOption[]>(
    initialFuturePlan ? [{ path: initialFuturePlan.sourcePath, relativePath: initialFuturePlan.sourceRelativePath }] : []
  )
  const [selectedFuturePlanPath, setSelectedFuturePlanPath] = useState(initialFuturePlan?.sourcePath ?? '')
  const [futurePlanContent, setFuturePlanContent] = useState<string | null>(initialFuturePlan?.sourceContent ?? null)
  const [futurePlanError, setFuturePlanError] = useState<string | null>(null)

  const recentFolders = useMemo(() => {
    const seen = new Set<string>()
    const folders: string[] = []
    const candidates = [
      ...storedRecentFolders,
      ...workspaces.map((workspace) => workspace.folderPath).filter((path): path is string => Boolean(path)),
    ]

    candidates.forEach((path) => {
      const key = folderKey(path)
      if (seen.has(key)) return
      seen.add(key)
      folders.push(path)
    })

    return folders.slice(0, maxVisibleRecentFolders)
  }, [storedRecentFolders, workspaces])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && allowClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose])

  const selected = LAYOUT_TEMPLATES.find((template) => template.id === selectedId) ?? LAYOUT_TEMPLATES[0]
  const totalAgents = countSwarmAgents(swarmRoleCounts)
  const swarmAccess = getSwarmAccessState(authState)
  const detailsComplete = name.trim().length > 0
  const swarmObjectiveComplete =
    selectedExistingTeam != null || (swarmTeamName.trim().length > 0 && swarmGoal.trim().length > 0)
  const multiloopObjectiveComplete =
    Boolean(folderPath?.trim()) && multiloopName.trim().length > 0 && multiloopGoal.trim().length > 0
  const futurePlanReady = selectedExistingTeam != null || !selectedFuturePlanPath || (futurePlanContent != null && !futurePlanError)
  const canCreate =
    !isCreating
    && detailsComplete
    && (
      mode === 'standard'
      || (mode === 'multiloop' && multiloopObjectiveComplete)
      || (mode === 'sprintengine'
        && (
      swarmAccess.allowed
      && futurePlanReady
      && (selectedExistingTeam != null || (swarmObjectiveComplete && totalAgents > 0))
        )
      )
    )

  const swarmConfig = useMemo<SwarmMockConfig>(
    () => ({
      name: swarmTeamName.trim() || name.trim() || 'Sprint Engine Team',
      goal: swarmGoal.trim(),
      roleCounts: swarmRoleCounts,
    }),
    [name, swarmGoal, swarmRoleCounts, swarmTeamName]
  )

  const scanFolder = async (dir: string) => {
    const entries = await window.api.readdir(joinPath(joinPath(dir, '.multi-code'), 'sprintengine')).catch(() => [])
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
        // Ignore folders that are not Sprint Engine state directories.
      }
    }

    const plans = await listMarkdownPlanOptions(dir)
    setExistingTeams(teams)
    setFuturePlanOptions((current) => {
      if (!selectedFuturePlanPath || plans.some((plan) => plan.path === selectedFuturePlanPath)) return plans
      const selected = current.find((plan) => plan.path === selectedFuturePlanPath)
      return selected ? [selected, ...plans] : plans
    })
  }

  const selectFolder = async (dir: string) => {
    const folderName = basename(dir)
    setFolderPath(dir)
    setSelectedExistingTeam(null)
    setExistingTeams([])
    setFuturePlanOptions([])
    setFuturePlanContent(null)
    setFuturePlanError(null)
    setSelectedFuturePlanPath('')
    if (!nameTouched) setName(folderName || 'workspace')
    if (!swarmTeamNameTouched) setSwarmTeamName(toTitleName(folderName) || 'Sprint Engine Team')
    if (!multiloopNameTouched) setMultiloopName(toTitleName(folderName) || 'Product Loop')
    setMultiloopError(null)

    setIsScanning(true)
    try {
      await scanFolder(dir)
    } finally {
      setIsScanning(false)
    }
  }

  useEffect(() => {
    if (!folderPath) return
    setIsScanning(true)
    scanFolder(folderPath).finally(() => setIsScanning(false))
    // Initial scan only; folder changes go through selectFolder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePick = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    await selectFolder(dir)
  }

  const selectFuturePlan = async (sourcePath: string) => {
    setSelectedFuturePlanPath(sourcePath)
    setFuturePlanError(null)

    if (!sourcePath) {
      setFuturePlanContent(null)
      return
    }

    const option = futurePlanOptions.find((candidate) => candidate.path === sourcePath)
    if (!option) {
      setFuturePlanContent(null)
      setFuturePlanError('Selected markdown file is not available.')
      return
    }

    try {
      const content = await window.api.readfile(option.path)
      const fallbackName = planBasename(option.path)
      const goal = markdownTitle(content) ?? toTitleName(fallbackName)
      setFuturePlanContent(content)
      if (!swarmTeamNameTouched) setSwarmTeamName(slugifySwarmName(fallbackName))
      if (!nameTouched) setName(slugifySwarmName(fallbackName))
      setSwarmGoal(goal)
      setSelectedExistingTeam(null)
    } catch {
      setFuturePlanContent(null)
      setFuturePlanError('Could not read the selected markdown file.')
    }
  }

  const handleModeChange = (nextMode: CreationMode) => {
    setMode(nextMode)
    if (nextMode !== 'sprintengine') setSelectedExistingTeam(null)
    if (nextMode === 'multiloop' && !multiloopNameTouched) {
      setMultiloopName(toTitleName(name || basename(folderPath ?? '')) || 'Product Loop')
    }
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

  const setRoleCliDefault = (role: SwarmRole, cli: AgentCli) => {
    setSwarmRoleCliDefaults((current) => ({
      ...current,
      [role]: cli,
    }))
  }

  const handleCreate = async () => {
    if (!canCreate) return

    if (mode === 'multiloop') {
      if (!folderPath) return

      setIsCreating(true)
      setMultiloopError(null)
      try {
        const created = await createMultiloopWorkspace({
          rootPath: folderPath,
          loopName: multiloopName,
          finalGoal: multiloopGoal,
          initializeState: window.api.initializeMultiloopState,
          readFile: window.api.readfile,
        })

        addWorkspace(createMultiloopTemplate(), {
          name: name.trim(),
          folderPath,
          multiloopState: created.state,
          multiloopContext: created.context,
        })
        onClose()
      } catch (error) {
        setMultiloopError(
          error instanceof MultiloopWorkspaceCreationError || error instanceof Error
            ? error.message
            : 'Could not create the Multiloop workspace.'
        )
      } finally {
        setIsCreating(false)
      }
      return
    }

    const swarmAutoState = mode === 'sprintengine'
      ? {
        useWorktreesForSwarms,
        isolateWorkersInWorktrees: useWorktreesForSwarms,
      }
      : null

    if (selectedExistingTeam) {
      const { displayName, state, context } = selectedExistingTeam
      const loadedState = { ...state, name: displayName }
      const template = createSwarmTemplate({
        name: loadedState.name,
        goal: loadedState.goal,
        roleCounts: loadedState.roleCounts,
      })
      onCreate({
        template,
        name: name.trim(),
        folderPath,
        swarmState: loadedState,
        swarmContext: context,
        swarmRoleCliDefaults,
        swarmAutoState,
      })
      return
    }

    if (mode === 'sprintengine' && selectedFuturePlanPath) {
      const option = futurePlanOptions.find((candidate) => candidate.path === selectedFuturePlanPath)
      if (!folderPath || !option || futurePlanContent == null) return

      setIsCreating(true)
      try {
        if (!(await window.api.pathExists(option.path))) {
          setFuturePlanError('Selected markdown file is not available.')
          return
        }

        await createPlanSourcedSwarmWorkspace({
          rootPath: folderPath,
          teamName: swarmTeamName,
          goal: swarmGoal,
          sourcePath: option.relativePath,
          sourceContent: futurePlanContent,
          workspaceName: name,
          roleCounts: swarmRoleCounts,
          roleCliDefaults: swarmRoleCliDefaults,
          useWorktreesForSwarms,
          pathExists: window.api.pathExists,
        })
        onClose()
      } catch (error) {
        if (error instanceof PlanSourcedSwarmWorkspaceError && error.code === 'team-exists') {
          setFuturePlanError('A Sprint Engine team with this name already exists.')
        } else {
          setFuturePlanError(error instanceof Error ? error.message : 'Could not create the Sprint Engine workspace.')
        }
      } finally {
        setIsCreating(false)
      }
      return
    }

    const swarmState = mode === 'sprintengine' ? createInitialSwarmState(swarmConfig) : null
    const template = mode === 'sprintengine' ? createSwarmTemplate(swarmConfig) : selected
    const swarmContext = mode === 'sprintengine' && folderPath && swarmState
      ? buildSwarmContext(folderPath, swarmState.name, slugifySwarmName(swarmState.name))
      : null
    onCreate({ template, name: name.trim(), folderPath, swarmState, swarmContext, swarmRoleCliDefaults, swarmAutoState })
  }

  const startLogin = async () => {
    await window.api.authLogin(authState.selectedOrganization?.id ?? null)
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
              onClick={() => void handleCreate()}
              disabled={!canCreate}
              className="h-9 rounded-md border border-[#ececee] bg-[#ececee] px-4 text-sm font-semibold text-[#08090b] transition-colors hover:bg-white disabled:border-[#303139] disabled:bg-[#17181d] disabled:text-[#5a5a63]"
            >
              {isCreating ? 'Creating...' : selectedExistingTeam ? 'Load Team' : mode === 'sprintengine' ? 'Create SprintEngine' : mode === 'multiloop' ? 'Create Multiloop' : 'Create Workspace'}
            </button>
          </div>
        </header>

        <div className="mt-5 min-h-0 flex-1">
          <main className="min-w-0 space-y-4">
            <div className="inline-flex rounded-md bg-[#111216] p-1">
              {[
                { id: 'standard' as const, label: 'Standard' },
                { id: 'sprintengine' as const, label: 'SprintEngine' },
                { id: 'multiloop' as const, label: 'Multiloop' },
              ].map((option) => {
                const active = mode === option.id
                const swarmOption = option.id === 'sprintengine'
                const multiloopOption = option.id === 'multiloop'
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleModeChange(option.id)}
                    className={`inline-flex h-8 items-center gap-2 rounded border px-3 text-sm font-semibold transition-colors ${
                      active && swarmOption
                        ? 'border-[#3a3426] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(255,191,47,0.42)]'
                        : active && multiloopOption
                          ? 'border-[#26373a] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(110,231,216,0.42)]'
                        : active
                          ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                          : swarmOption
                            ? 'border-transparent text-[#9a9aa2] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            : multiloopOption
                              ? 'border-transparent text-[#9a9aa2] hover:bg-[#6ee7d8]/8 hover:text-[#d8fffb]'
                            : 'border-transparent text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {swarmOption || multiloopOption ? (
                      <WorkspaceTypeIcon
                        mode={swarmOption ? 'sprintengine' : 'multiloop'}
                        className={`h-3.5 w-3.5 shrink-0 ${swarmOption ? 'text-[#ffbf2f]' : 'text-[#6ee7d8]'}`}
                      />
                    ) : null}
                    {option.label}
                  </button>
                )
              })}
            </div>

            {mode === 'sprintengine' ? <SprintEngineSplash /> : null}
            {mode === 'multiloop' ? <MultiloopSplash /> : null}

            {mode === 'sprintengine' && !swarmAccess.allowed ? (
              <section
                className="rounded-md border border-[#3a3426] bg-[#111216] p-4"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#ececee]">{swarmAccess.title}</div>
                    <div className="mt-1 max-w-2xl text-[13px] leading-5 text-[#a8a8b0]">
                      {swarmAccess.body}
                    </div>
                    {authState.selectedOrganization ? (
                      <div className="mt-2 truncate text-[12px] text-[#777780]">
                        Organization: {authState.selectedOrganization.name}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {swarmAccess.action === 'login' ? (
                      <button
                        type="button"
                        onClick={() => void startLogin()}
                        className="h-8 rounded-md border border-[#ececee] bg-[#ececee] px-3 text-[12px] font-semibold text-[#08090b] hover:bg-white"
                      >
                        Sign in
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

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
                  {recentFolders.length > 0 ? (
                    <div className="mt-2 min-w-0">
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[#777780]">
                        Recent
                      </div>
                      <div className="max-h-36 space-y-1 overflow-auto pr-1">
                        {recentFolders.map((recentFolder) => {
                          const active = folderPath ? folderKey(folderPath) === folderKey(recentFolder) : false
                          const label = basename(recentFolder) || recentFolder
                          return (
                            <button
                              key={recentFolder}
                              type="button"
                              aria-pressed={active}
                              title={recentFolder}
                              onClick={() => void selectFolder(recentFolder)}
                              className={`flex min-h-9 w-full min-w-0 items-center gap-3 rounded px-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-[#ececee]/25 ${
                                active
                                  ? 'bg-[#17181d] text-[#ececee]'
                                  : 'text-[#a8a8b0] hover:bg-[#111216] hover:text-[#d7d7dc]'
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  active ? 'bg-[#ececee]' : 'bg-[#3a3b42]'
                                }`}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12px] font-medium">{label}</span>
                                <span className="block truncate font-mono text-[11px] text-[#777780]">
                                  {recentFolder}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
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
                      if (mode === 'sprintengine' && !swarmTeamNameTouched) {
                        setSwarmTeamName(toTitleName(nextName))
                      }
                      if (mode === 'multiloop' && !multiloopNameTouched) {
                        setMultiloopName(toTitleName(nextName))
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleCreate()
                    }}
                    placeholder="my-workspace"
                    className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                  />
                </label>
              </div>
            </section>

            {mode === 'multiloop' ? (
              <section>
                <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <label className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Loop name
                      </span>
                      <input
                        value={multiloopName}
                        onChange={(event) => {
                          setMultiloopName(event.target.value)
                          setMultiloopNameTouched(true)
                          setMultiloopError(null)
                        }}
                        placeholder="Release Readiness"
                        className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                      />
                    </label>

                    <label className="block">
                      <span className="text-xs font-medium text-[#9a9aa2]">
                        Final goal
                      </span>
                      <textarea
                        value={multiloopGoal}
                        onChange={(event) => {
                          setMultiloopGoal(event.target.value)
                          setMultiloopError(null)
                        }}
                        placeholder="Describe the long-running outcome this loop should reach..."
                        className="mt-2 min-h-[160px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-3 text-[14px] leading-6 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                      />
                    </label>

                    {multiloopError ? (
                      <div className="border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
                        {multiloopError}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-[#24252b] bg-[#0d0e11] p-3">
                    <div className="mb-3 flex items-baseline justify-between gap-4">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#ececee]">Multiloop workspace</div>
                        <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                          Milestones, blockers, decisions, and evidence
                        </div>
                      </div>
                    </div>
                    <div className="rounded-md border border-[#303139] bg-[#08090b] p-3">
                      <MultiloopWorkspacePreview />
                    </div>
                  </div>
                </div>
              </section>
            ) : mode === 'sprintengine' ? (
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
                          setFuturePlanError(null)
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

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <label className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Existing plans
                      </span>
                      <select
                        value={selectedFuturePlanPath}
                        onChange={(event) => void selectFuturePlan(event.target.value)}
                        disabled={!folderPath || isScanning || selectedExistingTeam != null}
                        className="h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] outline-none transition-colors focus:border-[#ececee]/70 disabled:text-[#5a5a63]"
                      >
                        <option value="">
                          {isScanning ? 'Scanning plans...' : futurePlanOptions.length > 0 ? 'No existing plan' : 'No existing plans'}
                        </option>
                        {futurePlanOptions.map((plan) => (
                          <option key={plan.path} value={plan.path}>
                            {plan.relativePath}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Worktrees
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={useWorktreesForSwarms}
                        onClick={() => setUseWorktreesForSwarms((enabled) => !enabled)}
                        className={`flex h-[42px] items-center justify-between gap-3 rounded-md border px-3 text-sm font-semibold transition-colors ${
                          useWorktreesForSwarms
                            ? 'border-[#6ee7d8]/45 bg-[#6ee7d8]/12 text-[#d8fffb]'
                            : 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2] hover:bg-[#111216] hover:text-[#d7d7dc]'
                        }`}
                      >
                        <span>Use worktrees</span>
                        <span
                          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                            useWorktreesForSwarms ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                          }`}
                          aria-hidden="true"
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                              useWorktreesForSwarms ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </span>
                      </button>
                    </div>
                  </div>

                  {futurePlanError ? (
                    <div className="mt-3 border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
                      {futurePlanError}
                    </div>
                  ) : null}

                  <label className="mt-4 block">
                    <span className="text-xs font-medium text-[#9a9aa2]">
                      Objective
                    </span>
                    <textarea
                      value={swarmGoal}
                      onChange={(event) => {
                        setSelectedExistingTeam(null)
                        setSwarmGoal(event.target.value)
                        setFuturePlanError(null)
                      }}
                      placeholder="Describe the outcome this sprintengine should deliver..."
                      className="mt-2 min-h-[140px] w-full resize-none rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-3 text-[14px] leading-6 text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                    />
                  </label>
                </section>

                <section>
                  <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
                    <div>
                      <div className="mb-3 text-xs font-medium text-[#9a9aa2]">Sprint Engine roles</div>
                      <div className="border-t border-[#303139]">
                        {swarmRoleOrder.map((role) => (
                          <div
                            key={role}
                            className="flex min-h-[68px] items-center justify-between gap-3 border-b border-[#303139] px-3 py-2"
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
                            <label className="shrink-0">
                              <span className="sr-only">{swarmRoleLabels[role]} CLI</span>
                              <span className="relative block">
                                <select
                                  value={swarmRoleCliDefaults[role]}
                                  onChange={(event) => setRoleCliDefault(role, event.target.value as AgentCli)}
                                  className="h-8 appearance-none rounded-md border border-[#303139] bg-[#111216] py-1 pl-8 pr-7 text-[12px] font-semibold text-[#d7d7dc] outline-none transition-colors hover:bg-[#17181d] focus:border-[#ececee]/70"
                                >
                                  {cliOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#8a8a92]">
                                  <CliIcon cli={swarmRoleCliDefaults[role]} className="h-4 w-4" />
                                </span>
                                <svg
                                  className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5a5a63]"
                                  viewBox="0 0 20 20"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </span>
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#24252b] bg-[#0d0e11] p-3">
                      <div className="mb-3 flex items-baseline justify-between gap-4">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#ececee]">Sprint Engine workspace</div>
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

function SprintEngineSplash() {
  return (
    <div className="flex min-h-[112px] items-center justify-center px-2 py-3">
      <img
        src={sprintEngineSplash}
        alt="Sprint Engine"
        className="block w-full max-w-[620px] select-none object-contain"
        draggable={false}
      />
    </div>
  )
}

function MultiloopSplash() {
  return (
    <div className="flex min-h-[112px] items-center justify-center px-2 py-3">
      <img
        src={multiloopSplash}
        alt="Multiloop"
        className="block w-full max-w-[620px] select-none object-contain"
        draggable={false}
      />
    </div>
  )
}

function WorkspaceChrome({ modeLabel = 'SprintEngine' }: { modeLabel?: string }) {
  return (
    <g>
      <rect x="0" y="0" width="300" height="18" rx="8" fill="#08090b" />
      <rect x="8" y="4" width="68" height="11" rx="4" fill="#17181d" stroke="#303139" strokeWidth="0.8" />
      <text x="16" y="12" fill="#d7d7dc" fontSize="5.8" fontWeight="600">
        Workspace
      </text>
      <rect x="80" y="5" width="46" height="9" rx="3.5" fill="#111216" stroke="#24252b" strokeWidth="0.8" />
      <text x="88" y="11.6" fill="#9a9aa2" fontSize="5.2" fontWeight="600">
        {modeLabel}
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

function MultiloopWorkspacePreview() {
  return (
    <svg
      viewBox="0 0 300 110"
      preserveAspectRatio="xMidYMid meet"
      className="block aspect-[300/110] w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="300" height="110" rx="8" fill="#0d0e11" />
      <WorkspaceChrome modeLabel="Loop" />
      <rect x="6" y="22" width="288" height="82" rx="5" fill="#101116" stroke="#3a3b43" strokeWidth="1" />
      <rect x="15" y="31" width="72" height="6" rx="2" fill="#6ee7d8" opacity="0.82" />
      <rect x="15" y="43" width="120" height="3" rx="1.5" fill="#74757d" />
      <rect x="15" y="52" width="100" height="3" rx="1.5" fill="#5a5b63" />

      <rect x="15" y="68" width="74" height="23" rx="4" fill="#14151a" stroke="#303139" strokeWidth="0.8" />
      <rect x="24" y="76" width="38" height="3" rx="1.5" fill="#6ee7d8" opacity="0.85" />
      <rect x="24" y="84" width="48" height="2" rx="1" fill="#62636b" />

      <rect x="103" y="68" width="74" height="23" rx="4" fill="#17181d" stroke="#6ee7d8" strokeWidth="0.9" />
      <rect x="112" y="76" width="44" height="3" rx="1.5" fill="#d8fffb" opacity="0.86" />
      <rect x="112" y="84" width="36" height="2" rx="1" fill="#7c7d86" />

      <rect x="191" y="68" width="74" height="23" rx="4" fill="#14151a" stroke="#303139" strokeWidth="0.8" />
      <rect x="200" y="76" width="34" height="3" rx="1.5" fill="#74757d" />
      <rect x="200" y="84" width="46" height="2" rx="1" fill="#62636b" />

      <rect x="157" y="31" width="110" height="23" rx="4" fill="#17181d" stroke="#3a3b43" strokeWidth="0.8" />
      <rect x="167" y="38" width="16" height="3" rx="1.5" fill="#ff787c" />
      <rect x="190" y="38" width="52" height="3" rx="1.5" fill="#8a8b93" />
      <rect x="167" y="46" width="70" height="2" rx="1" fill="#62636b" />
    </svg>
  )
}
