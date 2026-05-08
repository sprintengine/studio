import { useEffect, useMemo, useState } from 'react'
import { createMultiloopTemplate, createSwarmReviewTemplate, createSwarmTemplate, createSymphonyTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
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
  SpecialistActionId,
  SwarmReviewSectorId,
  SwarmReviewWorkspaceState,
} from '../../types/workspace'
import { SPECIALIST_ACTIONS } from '../../specialists/specialistActions'
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
import swarmSplash from '../../assets/brand/swarm-splash.png'
import symphonySplash from '../../assets/brand/symphony-splash.png'
import multiloopWorkspacePreview from '../../assets/brand/multiloop-workspace-preview.png'
import sprintEngineWorkspacePreview from '../../assets/brand/sprintengine-workspace-preview.png'
import standardWorkspacePreview from '../../assets/brand/standard-workspace-preview.png'
import {
  SWARM_REVIEW_PRESETS,
  createSwarmReviewState,
  defaultSectorsForSpecialist,
  focusReviewSectorsForSpecialist,
  sectorLabel,
  type SwarmReviewPresetId,
} from '../../utils/swarmReview'

type ExistingTeam = {
  slug: string
  displayName: string
  context: SwarmWorkspaceContext
  state: SwarmState
}

type CreationMode = 'standard' | 'sprintengine' | 'symphony' | 'multiloop' | 'swarm'

type MarkdownPlanOption = {
  path: string
  relativePath: string
}

export type TemplateSelectorInitialState = {
  mode?: CreationMode
  folderPath?: string | null
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
    swarmReviewState?: SwarmReviewWorkspaceState | null
    mode?: 'standard' | 'sprintengine' | 'symphony' | 'multiloop' | 'swarm'
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
  frontend: 'bg-[#5c7cff]',
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

type SwarmReviewSelection = Record<SpecialistActionId, {
  included: boolean
  sectors: SwarmReviewSectorId[]
  cli: AgentCli
}>

const cliOptions: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
]

function initialSwarmReviewSelection(): SwarmReviewSelection {
  return Object.fromEntries(
    SPECIALIST_ACTIONS.map((action) => [
      action.id,
      {
        included: ['code-review', 'qa-test', 'performance'].includes(action.id),
        sectors: defaultSectorsForSpecialist(action.id),
        cli: 'codex' as AgentCli,
      },
    ])
  ) as SwarmReviewSelection
}

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

async function ensureSprintEngineStateFile(
  folderPath: string,
  context: SwarmWorkspaceContext,
  swarmState: SwarmState
): Promise<void> {
  const multiCodeDirectory = await window.api.ensureDir(folderPath, '.multi-code')
  const sprintEngineDirectory = await window.api.ensureDir(multiCodeDirectory, 'sprintengine')
  await window.api.ensureDir(sprintEngineDirectory, context.teamSlug)
  const exists = await window.api.pathExists(context.statePath)
  if (!exists) {
    const result = await window.api.initializeSprintEngineState({
      statePath: context.statePath,
      name: swarmState.name,
      goal: swarmState.goal,
      agents: swarmState.swarmAgents,
      tasks: swarmState.tasks,
      events: swarmState.events,
      artifacts: swarmState.artifacts,
    })
    if (!result.ok) throw new Error(result.message)
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
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [mode, setMode] = useState<CreationMode>(initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard'))
  const [selectedId, setSelectedId] = useState<string>(LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id)
  const [swarmTeamName, setSwarmTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [swarmTeamNameTouched, setSwarmTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [swarmGoal, setSwarmGoal] = useState(initialFuturePlan?.goal ?? '')
  const [multiloopName, setMultiloopName] = useState('')
  const [multiloopNameTouched, setMultiloopNameTouched] = useState(false)
  const [multiloopGoal, setMultiloopGoal] = useState('')
  const [multiloopError, setMultiloopError] = useState<string | null>(null)
  const [swarmReviewName, setSwarmReviewName] = useState('')
  const [swarmReviewNameTouched, setSwarmReviewNameTouched] = useState(false)
  const [swarmReviewPreset, setSwarmReviewPreset] = useState<SwarmReviewPresetId>('lean_code_review')
  const [swarmReviewSelection, setSwarmReviewSelection] = useState<SwarmReviewSelection>(() => initialSwarmReviewSelection())
  const [swarmRoleCounts, setSwarmRoleCounts] = useState<SwarmRoleCounts>(initialSwarmRoleCounts)
  const [swarmRoleCliDefaults, setSwarmRoleCliDefaults] = useState<Required<SwarmRoleCliDefaults>>(
    initialSwarmRoleCliDefaults
  )
  const [existingTeams, setExistingTeams] = useState<ExistingTeam[]>([])
  const [selectedExistingTeam, setSelectedExistingTeam] = useState<ExistingTeam | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
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
  const isSprintEngineLikeMode = mode === 'sprintengine' || mode === 'symphony'
  const detailsComplete = isSprintEngineLikeMode || mode === 'swarm' || name.trim().length > 0
  const swarmObjectiveComplete =
    selectedExistingTeam != null || (swarmTeamName.trim().length > 0 && swarmGoal.trim().length > 0)
  const symphonyObjectiveComplete = Boolean(folderPath?.trim()) && swarmTeamName.trim().length > 0
  const multiloopObjectiveComplete =
    Boolean(folderPath?.trim()) && multiloopName.trim().length > 0 && multiloopGoal.trim().length > 0
  const selectedSwarmReviewAgents = Object.entries(swarmReviewSelection)
    .filter(([specialistId, selection]) => {
      const focus = new Set(focusReviewSectorsForSpecialist(specialistId as SpecialistActionId).map((sector) => sector.id))
      return selection.included && selection.sectors.some((sector) => focus.has(sector))
    })
    .map(([specialistId, selection]) => ({
      specialistId: specialistId as SpecialistActionId,
      sectors: selection.sectors.filter((sector) =>
        focusReviewSectorsForSpecialist(specialistId as SpecialistActionId).some((focus) => focus.id === sector)
      ),
      cli: selection.cli,
    }))
  const swarmReviewComplete =
    Boolean(folderPath?.trim())
    && swarmReviewName.trim().length > 0
    && selectedSwarmReviewAgents.length > 0
  const futurePlanReady = selectedExistingTeam != null || !selectedFuturePlanPath || (futurePlanContent != null && !futurePlanError)
  const canCreate =
    !isCreating
    && detailsComplete
    && (
      mode === 'standard'
      || (mode === 'swarm' && swarmReviewComplete)
      || (mode === 'multiloop' && multiloopObjectiveComplete)
      || (mode === 'symphony' && swarmAccess.allowed && symphonyObjectiveComplete)
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
      name: swarmTeamName.trim() || 'Sprint Engine Team',
      goal: swarmGoal.trim() || (mode === 'symphony' ? 'Sync and triage GitHub issues through Symphony.' : ''),
      roleCounts: mode === 'symphony' ? initialSymphonyRoleCounts : swarmRoleCounts,
    }),
    [mode, swarmGoal, swarmRoleCounts, swarmTeamName]
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
    if (!swarmReviewNameTouched) setSwarmReviewName(toTitleName(folderName) || 'Swarm Review')
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
    if (nextMode === 'standard' && !nameTouched) {
      setName(basename(folderPath ?? '') || 'workspace')
    }
    if (nextMode === 'symphony') {
      const folderName = toTitleName(basename(folderPath ?? '')) || 'Symphony Workspace'
      if (!swarmTeamNameTouched) setSwarmTeamName(folderName)
      if (!swarmGoal.trim()) setSwarmGoal('Sync and triage GitHub issues through Symphony.')
      setSwarmRoleCounts(initialSymphonyRoleCounts)
    }
    if (nextMode === 'multiloop' && !multiloopNameTouched) {
      setMultiloopName(toTitleName(name || basename(folderPath ?? '')) || 'Product Loop')
    }
    if (nextMode === 'swarm' && !swarmReviewNameTouched) {
      setSwarmReviewName(toTitleName(name || basename(folderPath ?? '')) || 'Swarm Review')
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
  }

  const setRoleCliDefault = (role: SwarmRole, cli: AgentCli) => {
    setSwarmRoleCliDefaults((current) => ({
      ...current,
      [role]: cli,
    }))
  }

  const setRoleIncluded = (role: SwarmRole, included: boolean) => {
    if (role === 'architect') return
    setSelectedExistingTeam(null)
    setSwarmRoleCounts((current) => ({
      ...current,
      [role]: included ? Math.max(1, current[role]) : 0,
    }))
  }

  const applySwarmReviewPreset = (presetId: SwarmReviewPresetId) => {
    setSwarmReviewPreset(presetId)
    if (presetId === 'custom') return
    const preset = SWARM_REVIEW_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) return
    setSwarmReviewSelection((current) => {
      const next = { ...current }
      SPECIALIST_ACTIONS.forEach((action) => {
        const sectors = preset.agents[action.id]
        const focus = new Set(focusReviewSectorsForSpecialist(action.id).map((sector) => sector.id))
        next[action.id] = {
          ...current[action.id],
          included: Boolean(sectors?.length),
          sectors: sectors?.length
            ? sectors.filter((sector) => focus.has(sector))
            : current[action.id].sectors.filter((sector) => focus.has(sector)),
        }
      })
      return next
    })
  }

  const setSwarmReviewSpecialistIncluded = (specialistId: SpecialistActionId, included: boolean) => {
    setSwarmReviewPreset('custom')
    setSwarmReviewSelection((current) => ({
      ...current,
      [specialistId]: {
        ...current[specialistId],
        included,
      },
    }))
  }

  const toggleSwarmReviewSector = (specialistId: SpecialistActionId, sector: SwarmReviewSectorId) => {
    setSwarmReviewPreset('custom')
    setSwarmReviewSelection((current) => {
      const selection = current[specialistId]
      const hasSector = selection.sectors.includes(sector)
      const focus = new Set(focusReviewSectorsForSpecialist(specialistId).map((candidate) => candidate.id))
      if (!focus.has(sector)) return current
      const sectors = hasSector
        ? selection.sectors.filter((candidate) => candidate !== sector)
        : [...selection.sectors, sector]
      return {
        ...current,
        [specialistId]: {
          ...selection,
          sectors,
          included: sectors.length > 0 ? true : selection.included,
        },
      }
    })
  }

  const setSwarmReviewCli = (specialistId: SpecialistActionId, cli: AgentCli) => {
    setSwarmReviewSelection((current) => ({
      ...current,
      [specialistId]: {
        ...current[specialistId],
        cli,
      },
    }))
  }

  const handleCreate = async () => {
    if (!canCreate) return

    if (mode === 'swarm') {
      if (!folderPath) return
      const reviewState = createSwarmReviewState({
        name: swarmReviewName,
        objective: `Run a focused Swarm review for ${swarmReviewName.trim() || 'this workspace'}.`,
        folderPath,
        selectedAgents: selectedSwarmReviewAgents,
      })
      onCreate({
        template: createSwarmReviewTemplate(),
        name: reviewState.name,
        folderPath,
        swarmReviewState: reviewState,
        mode: 'swarm',
      })
      onClose()
      return
    }

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

    if (mode === 'symphony') {
      if (!folderPath) return

      setIsCreating(true)
      try {
        const symphonyState = createInitialSwarmState(swarmConfig)
        const teamSlug = slugifySwarmName(symphonyState.name)
        const context = buildSwarmContext(folderPath, symphonyState.name, teamSlug)
        await ensureSprintEngineStateFile(folderPath, context, symphonyState)
        onCreate({
          template: createSymphonyTemplate(swarmConfig),
          name: symphonyState.name,
          folderPath,
          swarmState: symphonyState,
          swarmContext: context,
          swarmRoleCliDefaults,
          swarmAutoState: { enabled: false },
          mode: 'symphony',
        })
      } catch (error) {
        setFuturePlanError(error instanceof Error ? error.message : 'Could not create the Symphony workspace.')
      } finally {
        setIsCreating(false)
      }
      return
    }

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
        name: loadedState.name,
        folderPath,
        swarmState: loadedState,
        swarmContext: context,
        swarmRoleCliDefaults,
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
          roleCounts: swarmRoleCounts,
          roleCliDefaults: swarmRoleCliDefaults,
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
    onCreate({
      template,
      name: mode === 'sprintengine' && swarmState ? swarmState.name : name.trim(),
      folderPath,
      swarmState,
      swarmContext,
      swarmRoleCliDefaults,
    })
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
              {isCreating ? 'Creating...' : selectedExistingTeam ? 'Load Team' : mode === 'sprintengine' ? 'Create SprintEngine' : mode === 'symphony' ? 'Create Symphony' : mode === 'multiloop' ? 'Create Multiloop' : mode === 'swarm' ? 'Create Swarm' : 'Create Workspace'}
            </button>
          </div>
        </header>

        <div className="mt-5 min-h-0 flex-1">
          <main className="min-w-0 space-y-4">
            <div className="inline-flex rounded-md bg-[#111216] p-1">
              {[
                { id: 'standard' as const, label: 'Standard' },
                { id: 'sprintengine' as const, label: 'SprintEngine' },
                { id: 'swarm' as const, label: 'Swarm' },
                { id: 'symphony' as const, label: 'Symphony' },
                { id: 'multiloop' as const, label: 'Multiloop' },
              ].map((option) => {
                const active = mode === option.id
                const swarmOption = option.id === 'sprintengine'
                const swarmReviewOption = option.id === 'swarm'
                const symphonyOption = option.id === 'symphony'
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
                        : active && swarmReviewOption
                          ? 'border-[#d97757] bg-[#241513] text-[#ffe2d4] shadow-[inset_0_-2px_0_rgba(217,119,87,0.68)]'
                        : active && symphonyOption
                          ? 'border-[#4c2d73] bg-[#1a1530] text-[#f1e8ff] shadow-[inset_0_-2px_0_rgba(124,92,242,0.72)]'
                        : active && multiloopOption
                          ? 'border-[#26373a] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(110,231,216,0.42)]'
                        : active
                          ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                          : swarmOption
                            ? 'border-transparent text-[#9a9aa2] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            : swarmReviewOption
                              ? 'border-transparent text-[#ffb088] hover:bg-[#d97757]/10 hover:text-[#ffe2d4]'
                            : symphonyOption
                              ? 'border-transparent text-[#d4c8ff] hover:bg-[#7c5cf2]/10 hover:text-[#efe5ff]'
                            : multiloopOption
                              ? 'border-transparent text-[#9a9aa2] hover:bg-[#5c7cff]/8 hover:text-[#d4ddff]'
                            : 'border-transparent text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {swarmOption || swarmReviewOption || symphonyOption || multiloopOption ? (
                      <WorkspaceTypeIcon
                        mode={swarmOption ? 'sprintengine' : swarmReviewOption ? 'swarm' : symphonyOption ? 'symphony' : 'multiloop'}
                        className={`h-3.5 w-3.5 shrink-0 ${
                          swarmOption
                            ? 'text-[#ffbf2f]'
                            : swarmReviewOption
                              ? 'text-[#d97757]'
                            : symphonyOption
                              ? 'text-[#a78bfa]'
                              : 'text-[#5c7cff]'
                        }`}
                      />
                    ) : null}
                    {option.label}
                  </button>
                )
              })}
            </div>

            {mode === 'sprintengine' ? <SprintEngineSplash /> : null}
            {mode === 'swarm' ? <SwarmSplash /> : null}
            {mode === 'symphony' ? <SymphonySplash /> : null}
            {mode === 'multiloop' ? <MultiloopSplash /> : null}

            {isSprintEngineLikeMode && !swarmAccess.allowed ? (
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

            {mode !== 'swarm' ? (
              <section className="border-b border-[#1f2025] pb-5">
                <div className={isSprintEngineLikeMode ? 'grid gap-4' : 'grid gap-4 lg:grid-cols-2'}>
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

                {!isSprintEngineLikeMode ? (
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
                ) : null}
              </div>
              </section>
            ) : null}

            {mode === 'symphony' ? (
              <section>
                <div className="max-w-[420px]">
                  <label className="flex min-w-0 flex-col gap-2">
                    <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                      Workspace name
                    </span>
                    <input
                      value={swarmTeamName}
                      onChange={(event) => {
                        setSwarmTeamName(event.target.value)
                        setSwarmTeamNameTouched(true)
                        setFuturePlanError(null)
                      }}
                      placeholder="Repo Triage"
                      className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                    />
                  </label>

                  {futurePlanError ? (
                    <div className="mt-4 border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
                      {futurePlanError}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : mode === 'multiloop' ? (
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
            ) : mode === 'swarm' ? (
              <section>
                <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">Folder</div>
                      <button
                        type="button"
                        onClick={handlePick}
                        className="flex h-[42px] w-full items-center gap-3 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-left transition-colors hover:bg-[#111216] focus:outline-none focus:ring-2 focus:ring-[#ececee]/25"
                      >
                        <span className={`min-w-0 flex-1 truncate text-sm ${folderPath ? 'text-[#d7d7dc]' : 'text-[#5a5a63]'}`}>
                          {folderPath ?? 'Choose folder'}
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-[#d7d7dc]">Browse</span>
                      </button>
                      {recentFolders.length > 0 ? (
                        <div className="mt-2 min-w-0">
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[#777780]">
                            Recent
                          </div>
                          <div className="max-h-28 space-y-1 overflow-auto pr-1">
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
                                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-[#ececee]' : 'bg-[#3a3b42]'}`} aria-hidden="true" />
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
                        Swarm name
                      </span>
                      <input
                        value={swarmReviewName}
                        onChange={(event) => {
                          setSwarmReviewName(event.target.value)
                          setSwarmReviewNameTouched(true)
                        }}
                        placeholder="Release Review"
                        className="block h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ececee]/70"
                      />
                    </label>

                    <label className="flex min-w-0 flex-col gap-2">
                      <span className="h-4 text-xs font-medium leading-4 text-[#9a9aa2]">
                        Preset
                      </span>
                      <select
                        value={swarmReviewPreset}
                        onChange={(event) => applySwarmReviewPreset(event.target.value as SwarmReviewPresetId)}
                        className="h-[42px] w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] outline-none transition-colors focus:border-[#ececee]/70"
                      >
                        {SWARM_REVIEW_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="rounded-lg border border-[#24252b] bg-[#0d0e11] p-3">
                    <div className="mb-3 flex items-baseline justify-between gap-4">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#ececee]">Roster</div>
                        <div className="mt-1 truncate text-[12px] text-[#9a9aa2]">
                          {selectedSwarmReviewAgents.length} selected agents with role-matched review focus
                        </div>
                      </div>
                    </div>
                    <div className="border-t border-[#303139]">
                      {SPECIALIST_ACTIONS.map((action) => {
                        const selection = swarmReviewSelection[action.id]
                        const focusSectors = focusReviewSectorsForSpecialist(action.id)
                        return (
                          <div key={action.id} className="border-b border-[#303139] px-3 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <span className="flex min-w-0 items-center gap-3">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={selection.included}
                                  aria-label={`Include ${action.shortLabel}`}
                                  onClick={() => setSwarmReviewSpecialistIncluded(action.id, !selection.included)}
                                  className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#ececee]/25 ${
                                    selection.included ? 'bg-[#5c7cff]' : 'bg-[#303139]'
                                  }`}
                                >
                                  <span
                                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                                      selection.included ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                    aria-hidden="true"
                                  />
                                </button>
                                <span className="min-w-0">
                                  <span className={`block truncate text-sm font-semibold ${selection.included ? 'text-[#ececee]' : 'text-[#777780]'}`}>
                                    {action.shortLabel}
                                  </span>
                                  <span className="mt-1 block text-[12px] leading-4 text-[#9a9aa2]">
                                    Focus: {focusSectors.map((sector) => sector.label).join(', ')}
                                  </span>
                                </span>
                              </span>
                              <select
                                value={selection.cli}
                                onChange={(event) => setSwarmReviewCli(action.id, event.target.value as AgentCli)}
                                disabled={!selection.included}
                                className="h-8 shrink-0 rounded-md border border-[#303139] bg-[#111216] px-2 text-[12px] font-semibold text-[#d7d7dc] outline-none focus:border-[#ececee]/70 disabled:text-[#5a5a63]"
                              >
                                {cliOptions.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selection.included ? (
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                {focusSectors.map((sector) => {
                                  const selectedSector = selection.sectors.includes(sector.id)
                                  return (
                                    <button
                                      key={sector.id}
                                      type="button"
                                      aria-pressed={selectedSector}
                                      onClick={() => toggleSwarmReviewSector(action.id, sector.id)}
                                      className={`rounded border px-2 py-1 text-[11px] font-medium ${
                                        selectedSector
                                          ? 'border-[#5c7cff] bg-[#182044] text-[#d4ddff]'
                                          : 'border-[#303139] bg-[#111216] text-[#8a8a92] hover:text-[#d7d7dc]'
                                      }`}
                                      title={sector.description}
                                    >
                                      {sectorLabel(sector.id)}
                                    </button>
                                  )
                                })}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
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
                      <div className="mb-3 text-xs font-medium text-[#9a9aa2]">Specialist roster</div>
                      <div className="border-t border-[#303139]">
                        {swarmRoleOrder.map((role) => {
                          const included = role === 'architect' || swarmRoleCounts[role] > 0
                          return (
                          <div
                            key={role}
                            className="flex min-h-[68px] items-center justify-between gap-3 border-b border-[#303139] px-3 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={included}
                                aria-label={`Include ${swarmRoleLabels[role]} in roster`}
                                disabled={role === 'architect' || selectedExistingTeam != null}
                                onClick={() => setRoleIncluded(role, !included)}
                                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#ececee]/25 disabled:opacity-55 ${
                                  included ? 'bg-[#5c7cff]' : 'bg-[#303139]'
                                }`}
                              >
                                <span
                                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                                    included ? 'translate-x-4' : 'translate-x-0'
                                  }`}
                                  aria-hidden="true"
                                />
                              </button>
                              <span className={`h-2 w-2 shrink-0 rounded-full ${included ? roleAccentClasses[role] : 'bg-[#3a3b42]'}`} />
                              <span className="min-w-0">
                                <span className={`block truncate text-sm font-semibold ${included ? 'text-[#ececee]' : 'text-[#777780]'}`}>
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
                                  disabled={!included}
                                  className="h-8 appearance-none rounded-md border border-[#303139] bg-[#111216] py-1 pl-8 pr-7 text-[12px] font-semibold text-[#d7d7dc] outline-none transition-colors hover:bg-[#17181d] focus:border-[#ececee]/70 disabled:text-[#5a5a63]"
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
                          )
                        })}
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
  const agentCount = agentCountLabel(slots)

  return (
    <WorkspacePreviewImage
      src={standardWorkspacePreview}
      alt={`Standard workspace layout preview, ${agentCount}`}
    />
  )
}

const initialSymphonyRoleCounts: SwarmRoleCounts = {
  architect: 1,
  product: 0,
  frontend: 0,
  developer: 1,
  code_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
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

function SymphonySplash() {
  return (
    <div className="flex min-h-[112px] items-center justify-center px-2 py-3">
      <img
        src={symphonySplash}
        alt="Symphony"
        className="block w-full max-w-[620px] select-none object-contain"
        draggable={false}
      />
    </div>
  )
}

function SwarmSplash() {
  return (
    <div className="flex min-h-[112px] items-center justify-center px-2 py-3">
      <img
        src={swarmSplash}
        alt="Swarm"
        className="block w-full max-w-[620px] select-none object-contain"
        draggable={false}
      />
    </div>
  )
}

function SwarmWorkspacePreview() {
  return (
    <WorkspacePreviewImage
      src={sprintEngineWorkspacePreview}
      alt="SprintEngine swarm Kanban workspace preview"
    />
  )
}

function MultiloopWorkspacePreview() {
  return (
    <WorkspacePreviewImage src={multiloopWorkspacePreview} alt="Multiloop milestone board workspace preview" />
  )
}

function WorkspacePreviewImage({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="block aspect-[16/9] w-full rounded-md object-cover"
      draggable={false}
    />
  )
}
