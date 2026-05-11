import { useEffect, useMemo, useState } from 'react'
import { createMultiloopTemplate, createSprintEngineTemplate, createSwitchboardTemplate, LAYOUT_TEMPLATES } from '../../layouts/templates'
import { SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import type {
  AgentCli,
  LayoutTemplate,
  PreviewSlot,
  SprintEngineMockConfig,
  SprintEngineRole,
  SprintEngineAutoState,
  FuturePlanWorkspaceSource,
  SprintEngineRoleCounts,
  SprintEngineRoleCliDefaults,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../types/workspace'
import {
  createPlanSourcedSprintEngineWorkspace,
  PlanSourcedSprintEngineWorkspaceError,
} from '../../utils/sprintengineWorkspaceCreation'
import {
  createMultiloopWorkspace,
  MultiloopWorkspaceCreationError,
} from '../../utils/multiloopWorkspaceCreation'
import {
  countSprintEngineAgents,
  buildSprintEngineAgentRoster,
  createInitialSprintEngineState,
  sprintEngineRoleAccent,
  sprintEngineRoleLabels,
  sprintEngineRoleOrder,
} from '../../utils/sprintengine'
import {
  getSprintEngineDirectoryPath,
  getExistingSprintEngineStateFilePath,
  getSprintEngineStateFilePath,
  parseSprintEngineStateFile,
  slugifySprintEngineName,
} from '../../utils/sprintengineStateFile'
import multiloopSplash from '../../assets/brand/multiloop-splash.png'
import sprintEngineSplash from '../../assets/brand/sprintengine-splash.png'
import switchboardSplash from '../../assets/brand/switchboard-splash.png'
import multiloopWorkspacePreview from '../../assets/brand/multiloop-workspace-preview.png'
import standardWorkspacePreview from '../../assets/brand/standard-workspace-preview.png'

type ExistingTeam = {
  slug: string
  displayName: string
  context: SprintEngineWorkspaceContext
  state: SprintEngineState
}

type CreationMode = 'standard' | 'sprintengine' | 'switchboard' | 'multiloop'

type MarkdownPlanOption = {
  path: string
  relativePath: string
}

export type TemplateSelectorInitialState = {
  mode?: CreationMode
  folderPath?: string | null
  futurePlanSource?: FuturePlanWorkspaceSource | null
}

type SprintEngineAccessState = {
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
    sprintEngineState?: SprintEngineState | null
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
    sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
    mode?: 'standard' | 'sprintengine' | 'switchboard' | 'multiloop'
  }) => void
  onClose: () => void
  allowClose?: boolean
  initialState?: TemplateSelectorInitialState | null
}

const roleSummaries: Record<SprintEngineRole, string> = {
  architect: 'Turns the objective into a plan, dependencies, and review gates.',
  product: 'Clarifies scope, tradeoffs, user value, and acceptance criteria.',
  frontend: 'Designs and implements responsive UI, interaction states, and polish.',
  developer: 'Builds core logic, integrations, refactors, and production code paths.',
  code_reviewer: 'Reviews implementation quality, regressions, and evidence before validation.',
  performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps after code review.',
  tester: 'Runs acceptance checks, regression passes, and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, abuse cases, and hardening risks.',
}

const roleAccentClasses: Record<SprintEngineRole, string> = {
  architect: 'bg-[#ffbf2f]',
  product: 'bg-[#8b5cf6]',
  developer: 'bg-[#30d158]',
  frontend: 'bg-[#5c7cff]',
  code_reviewer: 'bg-[#f59e0b]',
  performance: 'bg-[#a78bfa]',
  tester: 'bg-[#64a8ff]',
  security: 'bg-[#ff6b6b]',
}

const initialSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  developer: 0,
  code_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
}

const initialSprintEngineRoleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
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

function getExistingTeamDisplayName(slug: string, state: SprintEngineState): string {
  const stateName = state.name.trim()
  return slugifySprintEngineName(stateName) === slug.toLowerCase()
    ? stateName
    : toTitleName(slug)
}

function buildSprintEngineContext(folderPath: string, teamName: string, teamSlug: string): SprintEngineWorkspaceContext {
  return {
    teamName,
    teamSlug,
    teamDirectoryPath: getSprintEngineDirectoryPath(folderPath, teamSlug),
    statePath: getSprintEngineStateFilePath(folderPath, teamSlug),
  }
}

function getSprintEngineAccessState(authState: MulticodeAuthState): SprintEngineAccessState {
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
  const [sprintEngineTeamName, setSprintEngineTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [sprintEngineTeamNameTouched, setSprintEngineTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [sprintEngineGoal, setSprintEngineGoal] = useState(initialFuturePlan?.goal ?? '')
  const [multiloopName, setMultiloopName] = useState('')
  const [multiloopNameTouched, setMultiloopNameTouched] = useState(false)
  const [multiloopGoal, setMultiloopGoal] = useState('')
  const [multiloopError, setMultiloopError] = useState<string | null>(null)
  const [sprintEngineRoleCounts, setSprintEngineRoleCounts] = useState<SprintEngineRoleCounts>(initialSprintEngineRoleCounts)
  const [sprintEngineRoleCliDefaults, setSprintEngineRoleCliDefaults] = useState<Required<SprintEngineRoleCliDefaults>>(
    initialSprintEngineRoleCliDefaults
  )
  const [sprintEngineStartRunner, setSprintEngineStartRunner] = useState(true)
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
  const totalAgents = countSprintEngineAgents(sprintEngineRoleCounts)
  const sprintEngineAccess = getSprintEngineAccessState(authState)
  const isSprintEngineLikeMode = mode === 'sprintengine'
  const switchboardObjectiveComplete = Boolean(folderPath?.trim()) && name.trim().length > 0
  const detailsComplete = isSprintEngineLikeMode || name.trim().length > 0
  const sprintEngineObjectiveComplete =
    selectedExistingTeam != null || (sprintEngineTeamName.trim().length > 0 && sprintEngineGoal.trim().length > 0)
  const multiloopObjectiveComplete =
    Boolean(folderPath?.trim()) && multiloopName.trim().length > 0 && multiloopGoal.trim().length > 0
  const futurePlanReady = selectedExistingTeam != null || !selectedFuturePlanPath || (futurePlanContent != null && !futurePlanError)
  const canCreate =
    !isCreating
    && detailsComplete
    && (
      mode === 'standard'
      || (mode === 'multiloop' && multiloopObjectiveComplete)
      || (mode === 'switchboard' && switchboardObjectiveComplete)
      || (mode === 'sprintengine'
        && (
      sprintEngineAccess.allowed
      && futurePlanReady
      && (selectedExistingTeam != null || (sprintEngineObjectiveComplete && totalAgents > 0))
        )
      )
    )

  const sprintEngineConfig = useMemo<SprintEngineMockConfig>(
    () => ({
      name: sprintEngineTeamName.trim() || 'Sprint Engine Team',
      goal: sprintEngineGoal.trim(),
      roleCounts: sprintEngineRoleCounts,
    }),
    [sprintEngineGoal, sprintEngineRoleCounts, sprintEngineTeamName]
  )

  const scanFolder = async (dir: string) => {
    const entries = await window.api.readdir(joinPath(joinPath(dir, '.multi-code'), 'sprintengine')).catch(() => [])
    const teams: ExistingTeam[] = []
    for (const entry of entries) {
      if (!entry.isDir) continue
      try {
        const content = await window.api.readfile(getExistingSprintEngineStateFilePath(dir, entry.name))
        const state = parseSprintEngineStateFile(content, entry.name)
        const displayName = getExistingTeamDisplayName(entry.name, state)
        teams.push({
          slug: entry.name,
          displayName,
          context: buildSprintEngineContext(dir, displayName, entry.name),
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
    if (!sprintEngineTeamNameTouched) setSprintEngineTeamName(toTitleName(folderName) || 'Sprint Engine Team')
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
      if (!sprintEngineTeamNameTouched) setSprintEngineTeamName(slugifySprintEngineName(fallbackName))
      setSprintEngineGoal(goal)
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
    if (nextMode === 'switchboard' && !nameTouched) {
      setName(toTitleName(basename(folderPath ?? '')) || 'Switchboard')
    }
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
    setSprintEngineTeamName(team.displayName)
    setSprintEngineGoal(team.state.goal)
    setSprintEngineRoleCounts(team.state.roleCounts)
  }

  const setRoleCliDefault = (role: SprintEngineRole, cli: AgentCli) => {
    setSprintEngineRoleCliDefaults((current) => ({
      ...current,
      [role]: cli,
    }))
  }

  const setRoleIncluded = (role: SprintEngineRole, included: boolean) => {
    if (role === 'architect') return
    setSelectedExistingTeam(null)
    setSprintEngineRoleCounts((current) => ({
      ...current,
      [role]: included ? Math.max(1, current[role]) : 0,
    }))
  }

  const setRoleCount = (role: SprintEngineRole, count: number) => {
    const min = role === 'architect' ? 1 : 0
    setSelectedExistingTeam(null)
    setSprintEngineRoleCounts((current) => ({
      ...current,
      [role]: Math.max(min, Math.min(10, Math.floor(count))),
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

    if (mode === 'switchboard') {
      if (!folderPath) return
      const workspaceName = name.trim() || 'Switchboard'
      onCreate({
        template: createSwitchboardTemplate(),
        name: workspaceName,
        folderPath,
        mode: 'switchboard',
      })
      onClose()
      return
    }

    if (selectedExistingTeam) {
      const { displayName, state, context } = selectedExistingTeam
      const loadedState = { ...state, name: displayName }
      const template = createSprintEngineTemplate({
        name: loadedState.name,
        goal: loadedState.goal,
        roleCounts: loadedState.roleCounts,
      })
      onCreate({
        template,
        name: loadedState.name,
        folderPath,
        sprintEngineState: loadedState,
        sprintEngineContext: context,
        sprintEngineRoleCliDefaults,
        sprintEngineAutoState: {
          enabled: sprintEngineStartRunner,
          maxConcurrentAgents: Math.max(1, countSprintEngineAgents(loadedState.roleCounts)),
        },
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

        await createPlanSourcedSprintEngineWorkspace({
          rootPath: folderPath,
          teamName: sprintEngineTeamName,
          goal: sprintEngineGoal,
          sourcePath: option.relativePath,
          sourceContent: futurePlanContent,
          roleCounts: sprintEngineRoleCounts,
          roleCliDefaults: sprintEngineRoleCliDefaults,
          sprintEngineAutoState: {
            enabled: sprintEngineStartRunner,
            maxConcurrentAgents: Math.max(1, totalAgents),
          },
          pathExists: window.api.pathExists,
        })
        onClose()
      } catch (error) {
        if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
          setFuturePlanError('A Sprint Engine team with this name already exists.')
        } else {
          setFuturePlanError(error instanceof Error ? error.message : 'Could not create the Sprint Engine workspace.')
        }
      } finally {
        setIsCreating(false)
      }
      return
    }

    const sprintEngineState = mode === 'sprintengine' ? createInitialSprintEngineState(sprintEngineConfig) : null
    const template = mode === 'sprintengine' ? createSprintEngineTemplate(sprintEngineConfig) : selected
    const sprintEngineContext = mode === 'sprintengine' && folderPath && sprintEngineState
      ? buildSprintEngineContext(folderPath, sprintEngineState.name, slugifySprintEngineName(sprintEngineState.name))
      : null
    onCreate({
      template,
      name: mode === 'sprintengine' && sprintEngineState ? sprintEngineState.name : name.trim(),
      folderPath,
      sprintEngineState,
      sprintEngineContext,
      sprintEngineRoleCliDefaults,
      sprintEngineAutoState: mode === 'sprintengine'
        ? {
            enabled: sprintEngineStartRunner,
            maxConcurrentAgents: Math.max(1, totalAgents),
          }
        : null,
    })
  }

  const startLogin = async () => {
    await window.api.authLogin(authState.selectedOrganization?.id ?? null)
  }

  const createLabel = isCreating
    ? 'Creating...'
    : selectedExistingTeam
      ? 'Load Team'
      : mode === 'sprintengine'
        ? 'Create SprintEngine'
        : mode === 'switchboard'
          ? 'Create Switchboard'
          : mode === 'multiloop'
            ? 'Create Multiloop'
            : 'Create Workspace'

  return (
    <WorkspacePanel
      title="New Workspace"
      subtitle="Choose a workspace mode and configure its starting state."
      titleId="new-workspace-title"
      contentClassName="mx-auto min-h-full w-full max-w-5xl px-6 py-5"
      toolbar={
        <>
          {allowClose ? (
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-md border border-[#24252b] bg-[#111216] px-3 text-sm font-medium text-[#d7d7dc] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="h-8 rounded-md bg-[#5c7cff] px-4 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-not-allowed disabled:bg-[#17181d] disabled:text-[#5a5a63] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
          >
            {createLabel}
          </button>
        </>
      }
    >
        <div className="min-h-0 flex-1">
          <main className="min-w-0 space-y-4">
            <div className="inline-flex rounded-md bg-[#111216] p-1">
              {[
                { id: 'standard' as const, label: 'Standard' },
                { id: 'switchboard' as const, label: 'Switchboard' },
                { id: 'sprintengine' as const, label: 'SprintEngine' },
                { id: 'multiloop' as const, label: 'Multiloop' },
              ].map((option) => {
                const active = mode === option.id
                const sprintEngineOption = option.id === 'sprintengine'
                const switchboardOption = option.id === 'switchboard'
                const multiloopOption = option.id === 'multiloop'
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleModeChange(option.id)}
                    className={`inline-flex h-8 items-center gap-2 rounded border px-3 text-sm font-semibold transition-colors ${
                      active && sprintEngineOption
                        ? 'border-[#3a3426] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(255,191,47,0.42)]'
                        : active && switchboardOption
                          ? 'border-[#3b2f63] bg-[#1a1530] text-[#efe5ff] shadow-[inset_0_-2px_0_rgba(124,92,242,0.6)]'
                        : active && multiloopOption
                          ? 'border-[#26373a] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(110,231,216,0.42)]'
                        : active
                          ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                          : sprintEngineOption
                            ? 'border-transparent text-[#9a9aa2] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            : switchboardOption
                              ? 'border-transparent text-[#cdbcff] hover:bg-[#7c5cf2]/10 hover:text-[#efe5ff]'
                            : multiloopOption
                              ? 'border-transparent text-[#9a9aa2] hover:bg-[#5c7cff]/8 hover:text-[#d4ddff]'
                            : 'border-transparent text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                    }`}
                  >
                    {sprintEngineOption || switchboardOption || multiloopOption ? (
                      <WorkspaceTypeIcon
                        mode={sprintEngineOption ? 'sprintengine' : switchboardOption ? 'switchboard' : 'multiloop'}
                        className={`h-3.5 w-3.5 shrink-0 ${
                          sprintEngineOption
                            ? 'text-[#ffbf2f]'
                              : switchboardOption
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
            {mode === 'switchboard' ? <SwitchboardSplash /> : null}
            {mode === 'multiloop' ? <MultiloopSplash /> : null}

            {isSprintEngineLikeMode && !sprintEngineAccess.allowed ? (
              <section
                className="rounded-md border border-[#3a3426] bg-[#111216] p-4"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#ececee]">{sprintEngineAccess.title}</div>
                    <div className="mt-1 max-w-2xl text-[13px] leading-5 text-[#a8a8b0]">
                      {sprintEngineAccess.body}
                    </div>
                    {authState.selectedOrganization ? (
                      <div className="mt-2 truncate text-[12px] text-[#777780]">
                        Organization: {authState.selectedOrganization.name}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {sprintEngineAccess.action === 'login' ? (
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

            {true ? (
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
                        value={sprintEngineTeamName}
                        onChange={(event) => {
                          setSelectedExistingTeam(null)
                          setSprintEngineTeamName(event.target.value)
                          setSprintEngineTeamNameTouched(true)
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
                      value={sprintEngineGoal}
                      onChange={(event) => {
                        setSelectedExistingTeam(null)
                        setSprintEngineGoal(event.target.value)
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
                        {sprintEngineRoleOrder.map((role) => {
                          const included = role === 'architect' || sprintEngineRoleCounts[role] > 0
                          return (
                          <div
                            key={role}
                            className="grid min-h-[84px] gap-3 border-b border-[#303139] px-3 py-3"
                          >
                            <span className="flex min-w-0 items-start gap-3">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={included}
                                aria-label={`Include ${sprintEngineRoleLabels[role]} in roster`}
                                disabled={role === 'architect' || selectedExistingTeam != null}
                                onClick={() => setRoleIncluded(role, !included)}
                                className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#ececee]/25 disabled:opacity-55 ${
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
                              <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${included ? roleAccentClasses[role] : 'bg-[#3a3b42]'}`} />
                              <span className="min-w-0">
                                <span className={`block truncate text-sm font-semibold ${included ? 'text-[#ececee]' : 'text-[#777780]'}`}>
                                  {sprintEngineRoleLabels[role]}
                                </span>
                                <span className="mt-1 block text-[12px] leading-4 text-[#9a9aa2]">
                                  {roleSummaries[role]}
                                </span>
                              </span>
                            </span>
                            <div className="ml-12 flex min-w-0 items-center justify-between gap-2">
                              <div className="flex h-8 items-center overflow-hidden rounded-md border border-[#303139] bg-[#111216]">
                                <button
                                  type="button"
                                  aria-label={`Decrease ${sprintEngineRoleLabels[role]} count`}
                                  disabled={selectedExistingTeam != null || (role === 'architect' ? sprintEngineRoleCounts[role] <= 1 : sprintEngineRoleCounts[role] <= 0)}
                                  onClick={() => setRoleCount(role, sprintEngineRoleCounts[role] - 1)}
                                  className="h-8 w-8 text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]"
                                >
                                  -
                                </button>
                                <span className="min-w-7 text-center text-[12px] font-semibold text-[#ececee]">
                                  {sprintEngineRoleCounts[role]}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Increase ${sprintEngineRoleLabels[role]} count`}
                                  disabled={selectedExistingTeam != null || sprintEngineRoleCounts[role] >= 10}
                                  onClick={() => setRoleCount(role, sprintEngineRoleCounts[role] + 1)}
                                  className="h-8 w-8 text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#9a9aa2]"
                                >
                                  +
                                </button>
                              </div>
                            <label className="min-w-0">
                              <span className="sr-only">{sprintEngineRoleLabels[role]} CLI</span>
                              <span className="relative block">
                                <select
                                  value={sprintEngineRoleCliDefaults[role]}
                                  onChange={(event) => setRoleCliDefault(role, event.target.value as AgentCli)}
                                  disabled={!included}
                                  className="h-8 w-full min-w-[120px] appearance-none rounded-md border border-[#303139] bg-[#111216] py-1 pl-8 pr-7 text-[12px] font-semibold text-[#d7d7dc] outline-none transition-colors hover:bg-[#17181d] focus:border-[#ececee]/70 disabled:text-[#5a5a63]"
                                >
                                  {cliOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#8a8a92]">
                                  <CliIcon cli={sprintEngineRoleCliDefaults[role]} className="h-4 w-4" />
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
                          </div>
                          )
                        })}
                      </div>
                      <label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2">
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-[#ececee]">Start roster runner</span>
                          <span className="mt-1 block text-[12px] leading-4 text-[#9a9aa2]">
                            Launch selected Sprint Engine agents in the background when the workspace opens.
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={sprintEngineStartRunner}
                          onChange={(event) => setSprintEngineStartRunner(event.currentTarget.checked)}
                          className="h-4 w-4 shrink-0 accent-[#5c7cff] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
                        />
                      </label>
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
                      <div className="rounded-md border border-[#303139] bg-[#08090b]">
                        <SprintEngineWorkspacePreview roleCounts={sprintEngineRoleCounts} />
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
    </WorkspacePanel>
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

function SwitchboardSplash() {
  return (
    <div className="flex min-h-[112px] items-center justify-center px-2 py-3">
      <img
        src={switchboardSplash}
        alt="Switchboard"
        className="block w-full max-w-[620px] select-none object-contain"
        draggable={false}
      />
    </div>
  )
}

function SprintEngineWorkspacePreview({ roleCounts }: { roleCounts: SprintEngineRoleCounts }) {
  const roster = buildSprintEngineAgentRoster(roleCounts)
  const positions = buildSprintEnginePreviewMapPositions(roster)
  const visibleRoles = sprintEngineRoleOrder.filter((role) => roleCounts[role] > 0)
  const sampleTasks = [
    { id: 'T1', title: 'Shape requirements', role: 'product' as SprintEngineRole, status: 'Done', tone: 'text-[#d4ffdc] bg-[#12301b] border-[#30d158]/30' },
    { id: 'T2', title: 'Draft execution plan', role: 'architect' as SprintEngineRole, status: 'Ready', tone: 'text-[#ffe0a3] bg-[#2a210c] border-[#ffbf2f]/35' },
    { id: 'T3', title: 'Build implementation slice', role: 'developer' as SprintEngineRole, status: 'Next', tone: 'text-[#d7d7dc] bg-[#17181d] border-[#303139]' },
    { id: 'T4', title: 'Review and validate', role: 'code_reviewer' as SprintEngineRole, status: 'Gate', tone: 'text-[#ffdca6] bg-[#2a1a07] border-[#f59e0b]/35' },
  ]

  return (
    <div className="grid overflow-hidden rounded-md lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="min-w-0 border-b border-[#1f2025] p-4 lg:border-b-0 lg:border-r">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#f0d47a]">
          How Sprint Engine Opens
        </div>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[#d7d7dc]">
          A Sprint Engine workspace starts with an objective, an architect-owned plan, and a selected specialist roster. The roster becomes the run boundary: agents claim matching tasks, publish evidence, and route plan changes back through the architect.
        </p>

        <div className="mt-5 grid gap-2">
          {sampleTasks.map((task) => (
            <div
              key={task.id}
              className="grid grid-cols-[44px_minmax(0,1fr)_72px] items-center gap-3 rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2"
            >
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#5a5a63]">{task.id}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[#ececee]">{task.title}</span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.12em]">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: sprintEngineRoleAccent[task.role] }}
                  />
                  <span className="truncate" style={{ color: sprintEngineRoleAccent[task.role] }}>
                    {sprintEngineRoleLabels[task.role]}
                  </span>
                </span>
              </span>
              <span className={`truncate rounded-full border px-2 py-1 text-center text-[10px] font-bold uppercase tracking-[0.1em] ${task.tone}`}>
                {task.status}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {visibleRoles.map((role) => (
            <span
              key={role}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#303139] bg-[#111216] px-2 py-1 text-[11px] font-semibold text-[#d7d7dc]"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: sprintEngineRoleAccent[role] }} />
              {sprintEngineRoleLabels[role]}
              <span className="text-[#777780]">x{roleCounts[role]}</span>
            </span>
          ))}
        </div>
      </div>

      <div
        className="relative min-h-[320px] overflow-hidden bg-[#08090b]"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
        aria-label={`${roster.length} selected Sprint Engine roster agents`}
      >
        <div className="absolute left-4 top-4 z-10 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
          Roster Map
        </div>
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {positions
            .filter((node) => node.agent.role !== 'architect')
            .map((node) => (
              <line
                key={node.agent.id}
                x1="50"
                y1="38"
                x2={node.x}
                y2={node.y}
                stroke={sprintEngineRoleAccent[node.agent.role]}
                strokeWidth="0.22"
                strokeDasharray="1.4 1.8"
                opacity="0.46"
              />
            ))}
        </svg>

        {positions.map((node) => (
          <div
            key={node.agent.id}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-center"
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full border bg-[#111216] text-[#9a9aa2]"
              style={{ borderColor: sprintEngineRoleAccent[node.agent.role] }}
            >
              <SprintEngineRoleIcon role={node.agent.role} className="h-5 w-5" />
            </span>
            <span className="max-w-[86px] truncate text-[11px] font-semibold text-[#ececee]">{node.agent.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function buildSprintEnginePreviewMapPositions(
  roster: ReturnType<typeof buildSprintEngineAgentRoster>
): Array<{ agent: ReturnType<typeof buildSprintEngineAgentRoster>[number]; x: number; y: number }> {
  const architect = roster.find((agent) => agent.role === 'architect')
  const others = roster.filter((agent) => agent.role !== 'architect')
  const ordered = sprintEngineRoleOrder.flatMap((role) => others.filter((agent) => agent.role === role))
  const positions: Array<{ agent: ReturnType<typeof buildSprintEngineAgentRoster>[number]; x: number; y: number }> = []

  if (architect) positions.push({ agent: architect, x: 50, y: 38 })

  ordered.forEach((agent, index) => {
    const angle = (-108 + (216 / Math.max(1, ordered.length - 1)) * index) * (Math.PI / 180)
    const radiusX = 34
    const radiusY = 31
    positions.push({
      agent,
      x: 50 + Math.cos(angle) * radiusX,
      y: 55 + Math.sin(angle) * radiusY,
    })
  })

  return positions
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
