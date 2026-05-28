import { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES, createGuidedBriefTemplate, createMultiloopTemplate } from '../../layouts/templates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  AgentId,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
  McpCatalogServer,
  SkillPackCatalogEntry,
  SprintEngineAutoState,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineMockConfig,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineSourceBundleItem,
  SprintEngineSourceBundleKind,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
  Workspace,
  GuidedBriefRoleCliDefaults,
} from '../../types/workspace'
import { GuidedBriefFlow } from './guidedBrief/GuidedBriefFlow'
import { GuidedBriefCloseConfirmation } from './guidedBrief/GuidedBriefCloseConfirmation'
import { isMidStageGuidedRuntime, type GuidedBriefRuntimeState } from './guidedBrief/types'
import {
  guidedBriefBuildHandoffRelativePath,
  guidedBriefPlanningDecisionNotes,
  guidedBriefPlanningValidationNotes,
} from './guidedBrief/handoff'
import { joinWorkspacePath as joinGuidedWorkspacePath } from './guidedBrief/paths'
import {
  applyUserDisabledSprintEngineRoleCounts,
  countSprintEngineAgents,
  buildSprintEngineRoleRegistry,
  getSprintEngineRoleLabel,
  getUserDisabledSprintEngineRoleIds,
  sprintEngineRoleOrder,
} from '../../utils/sprintengine'
import { sprintEngineAutomationModeOptions } from '../../utils/sprintengineAutomation'
import MulticodeMark from '../brand/MulticodeMark'
import MulticodeWordmark from '../brand/MulticodeWordmark'
import { CloseIconButton, Field, Select, WizardProgress } from '../ui'
import { ModeCard } from './newWorkspace/ModeCard'
import { RecentFolderRow, isSameFolder } from './newWorkspace/RecentFolderRow'
import { SprintEngineRosterTable } from './newWorkspace/SprintEngineRosterTable'
import { useFolderHints, useFolderScan } from './newWorkspace/useNewWorkspaceFolder'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { basename, folderKey, planBasename, markdownTitle, toTitleName, inferSourcePlanKind } from './newWorkspace/helpers'
import type { CreationMode, ExistingTeam, GuidedBriefHasUi, SprintEnginePath } from './newWorkspace/types'
import { CliPermissionPresetRow, PathRadio } from './newWorkspace/WizardControls'
import { buildCliRuntimeOptions } from './newWorkspace/cliRuntimeOptions'
import {
  GuidedBriefScaffoldError,
  GuidedBriefStartBuildError,
  MultiloopControllerError,
  SprintEnginePlanSourcedError,
  buildSprintEngineExistingTeamCreation,
  buildSprintEngineNewTeamCreation,
  buildStandardCreation,
  buildSwitchboardCreation,
  runGuidedBriefScaffold,
  runGuidedBriefStartBuild,
  runMultiloopCreation,
  runSprintEnginePlanSourcedCreation,
} from './newWorkspace/controllers'

const MODES: CreationMode[] = ['standard', 'switchboard', 'sprintengine', 'multiloop', 'guided-brief']

type StepId =
  | 'workspace'
  | 'mode'
  | 'mcp-servers'
  | 'skill-packs'
  | 'standard-layout'
  | 'multiloop-goal'
  | 'sprintengine-team'
  | 'sprintengine-roster'
  | 'guided-idea'

const STEPS_BY_MODE: Record<CreationMode, StepId[]> = {
  standard: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'standard-layout'],
  switchboard: ['workspace', 'mode', 'mcp-servers', 'skill-packs'],
  multiloop: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'multiloop-goal'],
  sprintengine: ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'sprintengine-team', 'sprintengine-roster'],
  'guided-brief': ['workspace', 'mode', 'mcp-servers', 'skill-packs', 'guided-idea'],
}

const STEP_HEADING: Record<StepId, { title: string; subtitle: string }> = {
  workspace: {
    title: 'Name your workspace',
    subtitle: 'Give it a name and pick the folder it lives in.',
  },
  mode: {
    title: 'Choose a mode',
    subtitle: 'How will you use this workspace?',
  },
  'mcp-servers': {
    title: 'Pick MCP servers',
    subtitle: 'Agent tool integrations for this project. Optional — skip and add later from Settings.',
  },
  'skill-packs': {
    title: 'Pick skill packs',
    subtitle: 'Curated agent skills installed into this project on creation. Optional — skip and add later from Settings.',
  },
  'standard-layout': {
    title: 'Pick an IDE layout',
    subtitle: 'You can change this any time. The default fits most projects.',
  },
  'multiloop-goal': {
    title: 'Set the loop goal',
    subtitle: 'What outcome should this loop reach?',
  },
  'sprintengine-team': {
    title: 'Plan the team',
    subtitle: 'Pick a starting point and describe the objective.',
  },
  'sprintengine-roster': {
    title: 'Pick specialists',
    subtitle: 'Choose how many of each role and which CLI they default to.',
  },
  'guided-idea': {
    title: 'Tell us about your idea',
    subtitle: 'A sentence or two. The strategist will ask the rest.',
  },
}

const SOURCE_PLAN_KIND_LABELS: Record<SprintEngineSourcePlanKind, string> = {
  product_plan: 'Product plan',
  architect_plan: 'Implementation plan',
  unknown: 'Generic handoff',
}

const SOURCE_PLAN_KIND_OPTIONS: Array<{ value: SprintEngineSourcePlanKind; label: string }> = [
  { value: 'product_plan', label: SOURCE_PLAN_KIND_LABELS.product_plan },
  { value: 'architect_plan', label: SOURCE_PLAN_KIND_LABELS.architect_plan },
  { value: 'unknown', label: SOURCE_PLAN_KIND_LABELS.unknown },
]

const SOURCE_BUNDLE_KIND_LABELS: Record<string, string> = {
  ...SOURCE_PLAN_KIND_LABELS,
  html_mockup: 'HTML mockup',
  design_notes: 'Design notes',
  generic_context: 'Context',
}

const SOURCE_BUNDLE_KIND_OPTIONS: Array<{ value: SprintEngineSourceBundleKind; label: string }> = [
  { value: 'html_mockup', label: SOURCE_BUNDLE_KIND_LABELS.html_mockup },
  { value: 'product_plan', label: SOURCE_PLAN_KIND_LABELS.product_plan },
  { value: 'architect_plan', label: SOURCE_PLAN_KIND_LABELS.architect_plan },
  { value: 'design_notes', label: SOURCE_BUNDLE_KIND_LABELS.design_notes },
  { value: 'unknown', label: SOURCE_PLAN_KIND_LABELS.unknown },
  { value: 'generic_context', label: SOURCE_BUNDLE_KIND_LABELS.generic_context },
]

const initialSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  developer: 0,
  code_reviewer: 0,
  spec_reviewer: 0,
  performance: 0,
  tester: 0,
  security: 0,
}

const initialSprintEngineRoleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
  architect: 'claude',
  product: 'claude',
  frontend: 'claude',
  developer: 'claude',
  code_reviewer: 'claude',
  spec_reviewer: 'claude',
  performance: 'claude',
  tester: 'claude',
  security: 'claude',
}

const guidedBriefSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 1,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 1,
  performance: 0,
  tester: 1,
  security: 0,
}

function guidedBriefBuildRoleCountsForSurface(hasUi: GuidedBriefHasUi): SprintEngineRoleCounts {
  return {
    ...guidedBriefSprintEngineRoleCounts,
    frontend: hasUi === 'yes' ? guidedBriefSprintEngineRoleCounts.frontend : 0,
  }
}

function sprintEngineRosterSummary(roleCounts: SprintEngineRoleCounts, registry?: SprintEngineRoleRegistry | null): string[] {
  const roles = new Set<SprintEngineRoleId>([
    ...sprintEngineRoleOrder,
    ...Object.keys(roleCounts),
    ...Object.keys(registry?.roles ?? {}),
  ])
  return [...roles]
    .filter((role) => (roleCounts[role] ?? 0) > 0)
    .map((role) => `${getSprintEngineRoleLabel(role, registry)}: ${roleCounts[role]}`)
}

function normalizedPathKey(path: string | null | undefined): string | null {
  if (!path) return null
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function cliSelectionForExistingSprintEngineTeam(
  team: ExistingTeam,
  folderPath: string | null,
  workspaces: Workspace[],
  fallback: Required<SprintEngineRoleCliDefaults>,
): {
  roleDefaults: Required<SprintEngineRoleCliDefaults>
  agentOverrides: Record<AgentId, AgentCli>
} {
  const roleDefaults = { ...fallback }
  const agentOverrides: Record<AgentId, AgentCli> = {}
  const selectedFolderKey = normalizedPathKey(folderPath)
  const matchingWorkspace = workspaces.find((workspace) => (
    workspace.sprintEngineContext?.teamSlug === team.slug
    && normalizedPathKey(workspace.folderPath) === selectedFolderKey
  )) ?? workspaces.find((workspace) => (
    workspace.sprintEngineContext?.teamDirectoryPath
    && normalizedPathKey(workspace.sprintEngineContext.teamDirectoryPath) === normalizedPathKey(team.context.teamDirectoryPath)
  ))

  if (matchingWorkspace?.sprintEngineRoleCliDefaults) {
    for (const [role, cli] of Object.entries(matchingWorkspace.sprintEngineRoleCliDefaults)) {
      if (typeof cli === 'string' && cli.trim()) roleDefaults[role] = cli.trim()
    }
  }

  if (matchingWorkspace) {
    for (const [agentId, runtimeAgent] of Object.entries(team.state.sprintEngineAgents)) {
      const cli = matchingWorkspace.agents[agentId]?.cli
      if (typeof cli === 'string' && cli.trim()) {
        const trimmed = cli.trim()
        roleDefaults[runtimeAgent.role] = trimmed
        agentOverrides[agentId] = trimmed
      }
    }
  }

  return { roleDefaults, agentOverrides }
}

const initialGuidedBriefRoleCliDefaults: GuidedBriefRoleCliDefaults = {
  product: initialSprintEngineRoleCliDefaults.product ?? 'claude',
  architect: initialSprintEngineRoleCliDefaults.architect ?? 'claude',
  frontend: initialSprintEngineRoleCliDefaults.frontend ?? 'claude',
}

export type NewWorkspacePanelInitialState = {
  mode?: CreationMode
  folderPath?: string | null
  futurePlanSource?: FuturePlanWorkspaceSource | null
}

interface Props {
  onCreate: (args: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    sprintEngineState?: SprintEngineState | null
    sprintEngineContext?: SprintEngineWorkspaceContext | null
    sprintEngineRoleCliDefaults?: SprintEngineRoleCliDefaults | null
    sprintEngineAgentCliOverrides?: Record<AgentId, AgentCli> | null
    sprintEngineAutoState?: Partial<SprintEngineAutoState> | null
    mode?: WorkspaceMode
  }) => void
  onClose: () => void
  allowClose?: boolean
  initialState?: NewWorkspacePanelInitialState | null
}

export default function NewWorkspacePanel({
  onCreate,
  onClose,
  allowClose = true,
  initialState = null,
}: Props) {
  const authState = useWorkspaceStore((s) => s.authState)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const storedRecentFolders = useWorkspaceStore(
    (s) => s.appSettings.recentWorkspaceFolders ?? [],
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const lastSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? 'default',
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset,
  )

  const initialFuturePlan = initialState?.futurePlanSource ?? null
  const initialMode: CreationMode =
    initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard')
  const initialFolderPath = initialState?.folderPath ?? initialFuturePlan?.folderPath ?? null
  const initialWorkspaceName =
    initialFuturePlan ? '' : initialFolderPath ? basename(initialFolderPath) || 'workspace' : ''

  const [mode, setMode] = useState<CreationMode>(initialMode)
  const [folderPath, setFolderPath] = useState<string | null>(initialFolderPath)
  const [name, setName] = useState(initialWorkspaceName)
  const [nameTouched, setNameTouched] = useState(false)
  const [layoutId, setLayoutId] = useState<string>(
    LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id,
  )

  const [sePath, setSePath] = useState<SprintEnginePath>(initialFuturePlan ? 'plan' : 'new')
  const [sePlanPath, setSePlanPath] = useState(initialFuturePlan?.sourcePath ?? '')
  const [sePlanContent, setSePlanContent] = useState<string | null>(
    initialFuturePlan?.sourceContent ?? null,
  )
  const [seSourcePlanKind, setSeSourcePlanKind] = useState<SprintEngineSourcePlanKind>(
    initialFuturePlan?.sourcePlanKind ?? 'unknown',
  )
  const [seSourceBundle, setSeSourceBundle] = useState(initialFuturePlan?.sourceBundle ?? null)
  const [seExistingTeam, setSeExistingTeam] = useState<ExistingTeam | null>(null)
  const [seTeamName, setSeTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [seTeamNameTouched, setSeTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [seGoal, setSeGoal] = useState(initialFuturePlan?.goal ?? '')
  const [seRoleCounts, setSeRoleCounts] = useState<SprintEngineRoleCounts>(
    initialSprintEngineRoleCounts,
  )
  const [seRoleCliDefaults, setSeRoleCliDefaults] = useState<Required<SprintEngineRoleCliDefaults>>(
    initialSprintEngineRoleCliDefaults,
  )
  const [seAgentCliOverrides, setSeAgentCliOverrides] = useState<Record<AgentId, AgentCli>>({})
  const [seRoleRegistry, setSeRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
  const [seRoleRegistryStatus, setSeRoleRegistryStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const [seStartRunner, setSeStartRunner] = useState(false)
  const [sePlanError, setSePlanError] = useState<string | null>(null)
  const [cliPermissionPreset, setCliPermissionPreset] = useState<SprintEngineCliPermissionPreset>(
    lastSpawnPermissionPreset,
  )
  const [seAutoApproveArtifacts, setSeAutoApproveArtifacts] = useState(false)
  const seAutomationMode: SprintEngineAutomationMode = seAutoApproveArtifacts
    ? 'run_agents_and_approve_artifacts'
    : seStartRunner
      ? 'run_agents'
      : 'manual'
  const setSeAutomationMode = (mode: SprintEngineAutomationMode) => {
    setSeStartRunner(mode !== 'manual')
    setSeAutoApproveArtifacts(mode === 'run_agents_and_approve_artifacts')
  }

  const [mlName, setMlName] = useState('')
  const [mlGoal, setMlGoal] = useState('')
  const [mlError, setMlError] = useState<string | null>(null)

  const [guidedIdea, setGuidedIdea] = useState('')
  const [guidedHasUi, setGuidedHasUi] = useState<GuidedBriefHasUi | null>(null)
  const [guidedWantsProduct, setGuidedWantsProduct] = useState(true)
  const [guidedWantsArchitecture, setGuidedWantsArchitecture] = useState(false)
  const [guidedWantsFrontend, setGuidedWantsFrontend] = useState(true)
  const [guidedRoleCliDefaults, setGuidedRoleCliDefaults] = useState<GuidedBriefRoleCliDefaults>(
    initialGuidedBriefRoleCliDefaults,
  )
  const [guidedError, setGuidedError] = useState<string | null>(null)
  const [guidedRuntimeState, setGuidedRuntimeState] = useState<GuidedBriefRuntimeState | null>(null)
  const [viewingIdeaAfterCommit, setViewingIdeaAfterCommit] = useState(false)
  const [closeConfirmation, setCloseConfirmation] = useState(false)

  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const sprintEngineCliOptions = useMemo(
    () => buildCliRuntimeOptions(appCliRuntimes),
    [appCliRuntimes],
  )
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  const sprintEngineDisabledRoleIds = useMemo(
    () => getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings),
    [sprintEngineRoleSettings],
  )
  // Existing teams render canonical projection state; user settings must not
  // hide roles already configured on the team. Only mask the wizard view for
  // brand-new rosters.
  const effectiveSprintEngineDisabledRoleIds = useMemo<ReadonlySet<SprintEngineRoleId> | null>(
    () => (seExistingTeam ? null : sprintEngineDisabledRoleIds),
    [seExistingTeam, sprintEngineDisabledRoleIds],
  )
  const visibleSprintEngineRoleCounts = useMemo<SprintEngineRoleCounts>(
    () => (effectiveSprintEngineDisabledRoleIds && effectiveSprintEngineDisabledRoleIds.size > 0
      ? applyUserDisabledSprintEngineRoleCounts(seRoleCounts, effectiveSprintEngineDisabledRoleIds)
      : seRoleCounts),
    [seRoleCounts, effectiveSprintEngineDisabledRoleIds],
  )

  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const [integrationsMcpCatalog, setIntegrationsMcpCatalog] = useState<McpCatalogServer[]>([])
  const [integrationsSkillPackCatalog, setIntegrationsSkillPackCatalog] = useState<SkillPackCatalogEntry[]>([])
  const [integrationsMessage] = useState<string | null>(null)
  const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.mcpListCatalog === 'function') {
      void window.api.mcpListCatalog().then((result) => {
        if (cancelled) return
        if (result.ok) setIntegrationsMcpCatalog(result.servers)
      }).catch(() => {})
    }
    if (typeof window.api.skillPackListCatalog === 'function') {
      void window.api.skillPackListCatalog().then((result) => {
        if (cancelled) return
        if (result.ok) setIntegrationsSkillPackCatalog(result.packs)
      }).catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!folderPath || typeof window.api.readSprintEngineRegistryRoles !== 'function') {
      setSeRoleRegistry(null)
      setSeRoleRegistryStatus(folderPath ? 'unavailable' : 'idle')
      return undefined
    }
    setSeRoleRegistryStatus('loading')
    void window.api.readSprintEngineRegistryRoles({ workspaceRoot: folderPath, includeShadowed: true })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setSeRoleRegistry(buildSprintEngineRoleRegistry(result.data))
          setSeRoleRegistryStatus('ready')
        } else {
          setSeRoleRegistry(null)
          setSeRoleRegistryStatus('unavailable')
        }
      })
      .catch(() => {
        if (cancelled) return
        setSeRoleRegistry(null)
        setSeRoleRegistryStatus('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [folderPath])

  const toggleMcpInWizard = (server: McpCatalogServer) => {
    const enabled = Boolean(mcpSettings?.servers[server.id]?.enabled)
    if (enabled) {
      removeMcpServer(server.id)
    } else {
      upsertMcpServer({
        id: server.id,
        name: server.name,
        category: server.category,
        description: server.description,
        transport: server.transport,
        command: server.command,
        args: server.args ?? [],
        url: server.url,
        env: server.env,
        envVarNames: server.envVarNames ?? [],
        headers: server.headers,
        enabled: true,
        required: false,
        clients: server.defaultClients?.length ? server.defaultClients : server.clients,
        scope: server.recommendedScope ?? 'workspace',
        source: 'bundled',
        riskLevel: server.riskLevel,
        auth: server.auth,
        capabilities: server.capabilities,
        sourceUrl: server.sourceUrl,
      })
    }
  }

  const toggleSkillPackInWizard = (pack: SkillPackCatalogEntry) => {
    setSelectedSkillPackIds((current) => {
      const next = new Set(current)
      if (next.has(pack.id)) next.delete(pack.id)
      else next.add(pack.id)
      return next
    })
  }

  const triggerSelectedSkillPackInstalls = (workspaceRoot: string | null) => {
    if (!workspaceRoot) return
    if (typeof window.api.skillPackInstall !== 'function') return
    const picks = integrationsSkillPackCatalog.filter((pack) => selectedSkillPackIds.has(pack.id))
    for (const pack of picks) {
      void window.api
        .skillPackInstall({
          workspaceRoot,
          slug: pack.slug,
          harnesses: pack.harnesses,
          installedDirName: pack.installedDirName,
        })
        .catch(() => {})
    }
  }

  const [isCreating, setIsCreating] = useState(false)

  const folderScan = useFolderScan(folderPath)
  const totalAgents = countSprintEngineAgents(visibleSprintEngineRoleCounts)
  const isSprintEngine = mode === 'sprintengine'

  const [step, setStep] = useState<StepId>(initialFuturePlan ? 'sprintengine-team' : 'workspace')
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward')

  const steps = STEPS_BY_MODE[mode]
  const stepIndex = Math.max(0, steps.indexOf(step))
  const isLastStep = stepIndex >= steps.length - 1

  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const stepBodyRef = useRef<HTMLElement | null>(null)
  const logoOuterRef = useRef<HTMLDivElement | null>(null)
  const logoInnerRef = useRef<HTMLDivElement | null>(null)

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
    return folders
  }, [storedRecentFolders, workspaces])

  const folderHints = useFolderHints(recentFolders)

  // Sync initial future-plan option into the scan list once available.
  useEffect(() => {
    if (!initialFuturePlan) return
    setSePath('plan')
    setSePlanPath(initialFuturePlan.sourcePath)
    setSePlanContent(initialFuturePlan.sourceContent ?? null)
    setSeSourcePlanKind(initialFuturePlan.sourcePlanKind ?? 'unknown')
    setSeSourceBundle(initialFuturePlan.sourceBundle ?? null)
  }, [initialFuturePlan])

  // Escape closes when allowed. While a Guided brief runtime session is mid-
  // stage we route Escape through a confirmation step instead of dropping the
  // live conversation silently.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (closeConfirmation) {
        event.preventDefault()
        setCloseConfirmation(false)
        return
      }
      if (!allowClose) return
      if (isMidStageGuidedRuntime(guidedRuntimeState)) {
        event.preventDefault()
        setCloseConfirmation(true)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, allowClose, guidedRuntimeState, closeConfirmation])

  const requestClose = () => {
    if (isMidStageGuidedRuntime(guidedRuntimeState)) {
      setCloseConfirmation(true)
      return
    }
    onClose()
  }

  // Reset SprintEngine path if the folder loses prerequisites.
  useEffect(() => {
    if (!isSprintEngine) return
    if (sePath === 'existing' && folderScan.result.teams.length === 0) {
      setSePath('new')
      setSeExistingTeam(null)
      setSeAgentCliOverrides({})
    }
    if (sePath === 'plan' && !folderScan.isScanning && folderScan.result.plans.length === 0 && !sePlanPath) {
      setSePath('new')
    }
  }, [isSprintEngine, sePath, folderScan.result, folderScan.isScanning, sePlanPath])

  // When mode changes, ensure the current step exists in the new mode's step list.
  useEffect(() => {
    const list = STEPS_BY_MODE[mode]
    if (!list.includes(step)) {
      const fallback = list.includes('mode') ? 'mode' : list[0]
      setStep(fallback as StepId)
    }
  }, [mode, step])

  // Move focus to the step heading and reset scroll on step change.
  useEffect(() => {
    if (stepBodyRef.current) stepBodyRef.current.scrollTop = 0
    headingRef.current?.focus({ preventScroll: true })
  }, [step])

  // Auto-focus the name input when entering the workspace step.
  useEffect(() => {
    if (step === 'workspace') {
      const id = window.setTimeout(() => nameInputRef.current?.focus(), 60)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [step])

  // Mouse-reactive tilt for the welcome logo on the workspace step.
  useEffect(() => {
    if (step !== 'workspace') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const main = stepBodyRef.current
    if (!main) return

    let rafId: number | null = null
    const onMove = (event: MouseEvent) => {
      if (rafId != null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        const inner = logoInnerRef.current
        const outer = logoOuterRef.current
        if (!inner || !outer) return
        const rect = outer.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        // Tilt — normalize over a ~320px radius then clamp to [-1, 1].
        const dx = Math.max(-1, Math.min(1, (event.clientX - cx) / 320))
        const dy = Math.max(-1, Math.min(1, (event.clientY - cy) / 320))
        const rotateY = dx * 12
        const rotateX = -dy * 10
        inner.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`
        // Spotlight — clamp cursor to pedestal bounds in percent.
        const localX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
        const localY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
        outer.style.setProperty('--mx', `${localX}%`)
        outer.style.setProperty('--my', `${localY}%`)
      })
    }
    const onLeave = () => {
      if (rafId != null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      if (logoInnerRef.current) {
        logoInnerRef.current.style.transform = 'rotateX(0deg) rotateY(0deg)'
      }
      if (logoOuterRef.current) {
        logoOuterRef.current.style.setProperty('--mx', '50%')
        logoOuterRef.current.style.setProperty('--my', '50%')
      }
    }

    main.addEventListener('mousemove', onMove)
    main.addEventListener('mouseleave', onLeave)
    return () => {
      main.removeEventListener('mousemove', onMove)
      main.removeEventListener('mouseleave', onLeave)
      if (rafId != null) window.cancelAnimationFrame(rafId)
    }
  }, [step])

  const sprintEngineAccess = getSprintEngineAccessState(authState)

  const workspaceStepReady = Boolean(folderPath?.trim()) && name.trim().length > 0
  const standardLayoutStepReady = Boolean(layoutId)
  const multiloopGoalReady = mlGoal.trim().length > 0
  const sePlanReady =
    sePath !== 'plan' || (sePlanPath !== '' && sePlanContent != null && !sePlanError)
  const seObjectiveComplete =
    seExistingTeam != null || (seTeamName.trim().length > 0 && seGoal.trim().length > 0)
  const sprintEngineTeamReady =
    sprintEngineAccess.allowed && sePlanReady && seObjectiveComplete
  const sprintEngineRosterReady =
    sprintEngineAccess.allowed && (seExistingTeam != null || totalAgents > 0)
  const guidedIdeaReady = guidedIdea.trim().length > 0 && guidedHasUi != null

  const canAdvanceFromCurrent = isStepReady(step, {
    workspaceStepReady,
    standardLayoutStepReady,
    multiloopGoalReady,
    sprintEngineTeamReady,
    sprintEngineRosterReady,
    guidedIdeaReady,
  })

  const blockingMessage = getStepBlockingMessage({
    step,
    mode,
    folderPath,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seObjectiveComplete,
    totalAgents,
    guidedIdea,
    guidedHasUi,
  })

  const handleSelectMode = (next: CreationMode) => {
    setMode(next)
    if (next === 'standard' && !nameTouched) setName(basename(folderPath ?? '') || 'workspace')
    if (next === 'switchboard' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Switchboard')
    if (next === 'multiloop')
      setMlName(toTitleName(basename(folderPath ?? '')) || 'Product Loop')
    if (next === 'guided-brief' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Guided brief')
    if (next !== 'sprintengine') {
      setSeExistingTeam(null)
      setSeAgentCliOverrides({})
    }
    if (next !== 'guided-brief') {
      setGuidedError(null)
      setGuidedRuntimeState(null)
      setViewingIdeaAfterCommit(false)
    }
  }

  const handleChangeName = (value: string) => {
    setName(value)
    setNameTouched(true)
    // Mirror the single workspace name into mode-specific name slots so the
    // user never re-types the same name later. Mode-specific edits below still
    // override these values.
    setMlName(value)
    if (!seTeamNameTouched) setSeTeamName(value)
  }

  const handleSelectFolder = (dir: string) => {
    const folderName = basename(dir)
    setFolderPath(dir)
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    setSePlanPath('')
    setSePlanContent(null)
    setSeSourcePlanKind('unknown')
    setSeSourceBundle(null)
    setSePlanError(null)
    setMlError(null)
    if (!nameTouched) setName(folderName || 'workspace')
    if (!seTeamNameTouched) setSeTeamName(toTitleName(folderName) || 'Sprint Engine Team')
    setMlName(toTitleName(folderName) || 'Product Loop')

    const hint = folderHints.get(dir)
    if (hint && (hint.hasSprintEngineTeam || hint.hasMultiloop)) {
      if (!nameTouched && hint.hasSprintEngineTeam) handleSelectMode('sprintengine')
      else if (!nameTouched && hint.hasMultiloop) handleSelectMode('multiloop')
    }
  }

  const pickFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    handleSelectFolder(dir)
  }

  const handleSelectExistingTeam = (slug: string) => {
    const team = folderScan.result.teams.find((candidate) => candidate.slug === slug)
    if (!team) {
      setSeExistingTeam(null)
      setSeAgentCliOverrides({})
      return
    }
    const cliSelection = cliSelectionForExistingSprintEngineTeam(team, folderPath, workspaces, seRoleCliDefaults)
    setSeExistingTeam(team)
    setSeTeamName(team.displayName)
    setSeGoal(team.state.goal)
    setSeRoleCounts(team.state.roleCounts)
    setSeRoleCliDefaults(cliSelection.roleDefaults)
    setSeAgentCliOverrides(cliSelection.agentOverrides)
  }

  const handleSelectPlan = async (sourcePath: string) => {
    setSePlanPath(sourcePath)
    setSePlanError(null)
    if (!sourcePath) {
      setSePlanContent(null)
      setSeSourcePlanKind('unknown')
      setSeSourceBundle(null)
      return
    }
    const option = folderScan.result.plans.find((candidate) => candidate.path === sourcePath)
    if (!option) {
      setSePlanContent(null)
      setSePlanError('Selected source file is not available.')
      return
    }
    try {
      const content = await window.api.readfile(option.path)
      const fallbackName = planBasename(option.path)
      const goal = markdownTitle(content) ?? toTitleName(fallbackName)
      const isHtmlSource = /\.html?$/i.test(option.relativePath)
      setSePlanContent(content)
      setSeSourcePlanKind(isHtmlSource ? 'unknown' : inferSourcePlanKind(option.relativePath, content))
      setSeSourceBundle(isHtmlSource
        ? [{
          kind: 'html_mockup',
          sourcePath: option.path,
          sourceRelativePath: option.relativePath,
          sourceContent: content,
        }]
        : null)
      if (!seTeamNameTouched) setSeTeamName(slugifySprintEngineName(fallbackName))
      setSeGoal(goal)
      setSeExistingTeam(null)
      setSeAgentCliOverrides({})
    } catch {
      setSePlanContent(null)
      setSePlanError('Could not read the selected markdown file.')
    }
  }

  const setRoleCount = (role: SprintEngineRoleId, count: number) => {
    const min = role === 'architect' ? 1 : 0
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    setSeRoleCliDefaults((current) => ({
      ...current,
      [role]: current[role] ?? 'claude',
    }))
    setSeRoleCounts((current) => ({
      ...current,
      [role]: Math.max(min, Math.min(10, Math.floor(count))),
    }))
  }

  const setRoleCli = (role: SprintEngineRoleId, cli: AgentCli) => {
    setSeRoleCliDefaults((current) => ({ ...current, [role]: cli }))
    setSeAgentCliOverrides((current) => {
      if (!seExistingTeam) return current
      let changed = false
      const next = { ...current }
      for (const [agentId, runtimeAgent] of Object.entries(seExistingTeam.state.sprintEngineAgents)) {
        if (runtimeAgent.role !== role) continue
        if (agentId in next) {
          delete next[agentId]
          changed = true
        }
      }
      return changed ? next : current
    })
  }

  const setGuidedRoleCli = (role: keyof GuidedBriefRoleCliDefaults, cli: AgentCli) => {
    setGuidedRoleCliDefaults((current) => ({ ...current, [role]: cli }))
  }

  const sprintEngineConfig = useMemo<SprintEngineMockConfig>(
    () => ({
      name: seTeamName.trim() || 'Sprint Engine Team',
      goal: seGoal.trim(),
      roleCounts: visibleSprintEngineRoleCounts,
    }),
    [seGoal, visibleSprintEngineRoleCounts, seTeamName],
  )

  const persistLastPermissionPreset = () => {
    setLastAgentSpawnPermissionPreset(cliPermissionPreset)
  }

  const handleCreate = async () => {
    if (!sprintEngineRosterReady && mode === 'sprintengine') return
    if (mode === 'sprintengine') setSePlanError(null)

    if (mode === 'guided-brief') {
      if (!folderPath) {
        setGuidedError('Pick a folder before continuing.')
        return
      }
      if (!guidedIdea.trim() || guidedHasUi == null) return
      if (guidedRuntimeState) {
        // User pressed Back, then Continue — return to the live runtime without rescaffolding.
        setViewingIdeaAfterCommit(false)
        return
      }
      setIsCreating(true)
      setGuidedError(null)
      try {
        const { runtimeState } = await runGuidedBriefScaffold(
          {
            folderPath,
            workspaceName: name,
            idea: guidedIdea,
            hasUi: guidedHasUi,
            wantsProduct: guidedWantsProduct,
            wantsArchitecture: guidedWantsArchitecture,
            wantsFrontend: guidedWantsFrontend,
            guidedRoleCliDefaults,
            buildRoleCounts: applyUserDisabledSprintEngineRoleCounts(
              guidedBriefBuildRoleCountsForSurface(guidedHasUi),
              sprintEngineDisabledRoleIds,
            ),
            buildRoleCliDefaults: seRoleCliDefaults,
            buildCliPermissionPreset: cliPermissionPreset,
            buildStartRunner: seStartRunner,
            buildAutoApproveArtifacts: seAutoApproveArtifacts,
          },
          {
            filesystem: {
              ensureDir: window.api.ensureDir,
              readFile: window.api.readfile,
              writeFile: window.api.writefile,
            },
            addWorkspace,
            createGuidedBriefTemplate,
          },
        )
        void runtimeState
        triggerSelectedSkillPackInstalls(folderPath)
        onClose()
      } catch (error) {
        setGuidedError(
          error instanceof GuidedBriefScaffoldError && error.message !== error.code
            ? error.message
            : error instanceof GuidedBriefScaffoldError
              ? `Could not scaffold the guided brief workspace (${error.code}).`
              : error instanceof Error
                ? error.message
                : 'Could not scaffold the guided brief workspace.',
        )
      } finally {
        setIsCreating(false)
      }
      return
    }

    if (mode === 'multiloop') {
      if (!folderPath) return
      setIsCreating(true)
      setMlError(null)
      try {
        await runMultiloopCreation(
          {
            folderPath,
            workspaceName: name,
            loopName: mlName,
            finalGoal: mlGoal,
            cliPermissionPreset,
          },
          {
            initializeMultiloopState: window.api.initializeMultiloopState,
            readFile: window.api.readfile,
            addWorkspace,
            createMultiloopTemplate,
          },
        )
        triggerSelectedSkillPackInstalls(folderPath)
        persistLastPermissionPreset()
        onClose()
      } catch (error) {
        setMlError(
          error instanceof MultiloopControllerError || error instanceof Error
            ? error.message
            : 'Could not create the Multiloop workspace.',
        )
      } finally {
        setIsCreating(false)
      }
      return
    }

    if (mode === 'switchboard') {
      if (!folderPath) return
      const args = buildSwitchboardCreation({ name, folderPath })
      triggerSelectedSkillPackInstalls(folderPath)
      onCreate(args)
      onClose()
      return
    }

    if (mode === 'sprintengine') {
      if (seExistingTeam) {
        const args = buildSprintEngineExistingTeamCreation({
          folderPath,
          existingTeam: seExistingTeam,
          roleCliDefaults: seRoleCliDefaults,
          agentCliOverrides: seAgentCliOverrides,
          startRunner: seStartRunner,
          autoApproveArtifacts: seAutoApproveArtifacts,
          cliPermissionPreset,
        })
        triggerSelectedSkillPackInstalls(folderPath)
        onCreate(args)
        persistLastPermissionPreset()
        return
      }

      if (sePath === 'plan' && sePlanPath) {
        if (!folderPath) {
          setSePlanError('Pick a folder before creating from a plan.')
          return
        }
        const bundlePrimary = seSourceBundle?.[0] ?? null
        const option = bundlePrimary
          ? { path: bundlePrimary.sourcePath, relativePath: bundlePrimary.sourceRelativePath }
          : folderScan.result.plans.find((candidate) => candidate.path === sePlanPath)
        if (!option) {
          setSePlanError('Selected plan is no longer available. Pick it again on the previous step.')
          return
        }
        if (sePlanContent == null) {
          setSePlanError('Plan content was not loaded. Re-select the plan on the previous step.')
          return
        }
        if (!seTeamName.trim()) {
          setSePlanError('Add a team name on the previous step.')
          return
        }
        if (!seGoal.trim()) {
          setSePlanError('Add an objective on the previous step.')
          return
        }
        setIsCreating(true)
        try {
          await runSprintEnginePlanSourcedCreation(
            {
              folderPath,
              teamName: seTeamName,
              goal: seGoal,
              sourcePlanPath: option.path,
              sourcePlanRelativePath: option.relativePath,
              sourcePlanContent: sePlanContent,
              sourcePlanKind: seSourcePlanKind,
              sourceBundle: seSourceBundle ?? null,
              visibleRoleCounts: visibleSprintEngineRoleCounts,
              totalAgents,
              roleCliDefaults: seRoleCliDefaults,
              startRunner: seStartRunner,
              autoApproveArtifacts: seAutoApproveArtifacts,
              cliPermissionPreset,
            },
            { pathExists: window.api.pathExists },
          )
          triggerSelectedSkillPackInstalls(folderPath)
          persistLastPermissionPreset()
          onClose()
        } catch (error) {
          if (error instanceof SprintEnginePlanSourcedError) {
            setSePlanError(planSourcedErrorMessage(error))
          } else {
            setSePlanError(
              error instanceof Error ? error.message : 'Could not create the Sprint Engine workspace.',
            )
          }
        } finally {
          setIsCreating(false)
        }
        return
      }

      const args = buildSprintEngineNewTeamCreation({
        folderPath,
        teamName: sprintEngineConfig.name,
        goal: sprintEngineConfig.goal,
        roleCounts: visibleSprintEngineRoleCounts,
        visibleRoleCounts: visibleSprintEngineRoleCounts,
        totalAgents,
        roleCliDefaults: seRoleCliDefaults,
        startRunner: seStartRunner,
        autoApproveArtifacts: seAutoApproveArtifacts,
        cliPermissionPreset,
      })
      triggerSelectedSkillPackInstalls(folderPath)
      onCreate(args)
      persistLastPermissionPreset()
      return
    }

    // Standard
    const args = buildStandardCreation({ layoutId, name, folderPath })
    triggerSelectedSkillPackInstalls(folderPath)
    onCreate(args)
  }

  const goNext = () => {
    if (!canAdvanceFromCurrent || isCreating) return
    if (isLastStep) {
      void handleCreate()
      return
    }
    setDirection('forward')
    setStep(steps[stepIndex + 1])
  }

  const goBack = () => {
    if (stepIndex === 0) return
    setDirection('backward')
    setStep(steps[stepIndex - 1])
  }

  const handleSectionKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.isDefaultPrevented()) return
    const target = event.target as HTMLElement
    const tag = target.tagName
    // Buttons (and role=radio buttons) handle Enter natively as click.
    if (tag === 'BUTTON') return
    // Selects use Enter to open/close the dropdown.
    if (tag === 'SELECT') return
    // Textareas insert newlines on Enter; Cmd/Ctrl+Enter advances.
    if (tag === 'TEXTAREA' && !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    goNext()
  }

  const startLogin = async () => {
    await window.api.authLogin(authState.selectedOrganization?.id ?? null)
  }

  const handleGuidedStartBuild = async (
    runtimeState: GuidedBriefRuntimeState,
    runOptions: {
      startRunner: boolean
      autoApproveArtifacts: boolean
      roleCounts: SprintEngineRoleCounts
      roleCliDefaults: Required<SprintEngineRoleCliDefaults>
      cliPermissionPreset: SprintEngineCliPermissionPreset
    } = {
      startRunner: seStartRunner,
      autoApproveArtifacts: seAutoApproveArtifacts,
      roleCounts: runtimeState.buildRoleCounts,
      roleCliDefaults: runtimeState.buildRoleCliDefaults,
      cliPermissionPreset: runtimeState.buildCliPermissionPreset,
    },
  ) => {
    if (!sprintEngineAccess.allowed) {
      await startLogin()
      throw new Error('Sign in to use Sprint Engine mode.')
    }
    const finalRoleCounts = applyUserDisabledSprintEngineRoleCounts(
      runOptions.roleCounts,
      sprintEngineDisabledRoleIds,
    )
    try {
      await runGuidedBriefStartBuild(
        {
          runtimeState,
          runOptions,
          finalRoleCounts,
          rosterSummary: sprintEngineRosterSummary(finalRoleCounts, seRoleRegistry),
          planningDecisions: guidedBriefPlanningDecisionNotes(runtimeState),
          planningValidationNotes: guidedBriefPlanningValidationNotes(runtimeState),
          buildHandoffRelativePath: guidedBriefBuildHandoffRelativePath(),
        },
        {
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
          pathExists: window.api.pathExists,
          readArchitecturePlan: (workspaceRoot, path) =>
            window.api.readfile(joinGuidedWorkspacePath(workspaceRoot, path)),
          readBuildHandoff: (workspaceRoot, path) =>
            window.api.readfile(joinGuidedWorkspacePath(workspaceRoot, path)),
        },
      )
    } catch (error) {
      if (error instanceof GuidedBriefStartBuildError) {
        throw new Error(guidedBriefStartBuildErrorMessage(error))
      }
      throw error instanceof Error ? error : new Error('Could not create the Sprint Engine workspace.')
    }
    triggerSelectedSkillPackInstalls(runtimeState.workspaceRoot)
    persistLastPermissionPreset()
    onClose()
  }

  const primaryLabel = isLastStep
    ? createLabelFor(mode, isCreating, seExistingTeam != null)
    : 'Continue'

  const stepHeading = STEP_HEADING[step]
  const stepAnimationClass =
    direction === 'forward' ? 'wizard-step-in-forward' : 'wizard-step-in-backward'

  const guidedFlowVisible = guidedRuntimeState != null && !viewingIdeaAfterCommit

  return (
    <section
      aria-labelledby="new-workspace-title"
      tabIndex={-1}
      onKeyDown={handleSectionKeyDown}
      className="relative flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] outline-none"
    >
      {guidedRuntimeState ? (
        <div
          aria-hidden={!guidedFlowVisible}
          className={`absolute inset-0 z-10 transition-opacity ${
            guidedFlowVisible
              ? 'opacity-100 motion-safe:duration-200'
              : 'pointer-events-none opacity-0'
          }`}
        >
          <GuidedBriefFlow
            runtimeState={guidedRuntimeState}
            onChange={setGuidedRuntimeState}
            onBackToIdea={() => setViewingIdeaAfterCommit(true)}
            onClose={requestClose}
            onStartBuild={handleGuidedStartBuild}
            cliRuntimes={appCliRuntimes}
            sprintEngineRoleRegistry={seRoleRegistry}
            sprintEngineDisabledRoleIds={sprintEngineDisabledRoleIds}
          />
        </div>
      ) : null}
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--bg-surface-raised)] px-5 py-3">
        <div className="flex shrink-0 items-center gap-2">
          <MulticodeMark className="h-[18px] w-[18px]" variant="mono" />
          <h2
            id="new-workspace-title"
            className="text-[13px] font-semibold text-[color:var(--text-strong)]"
          >
            New workspace
          </h2>
        </div>
        <WizardProgress total={steps.length} active={stepIndex} />
        {allowClose ? (
          <CloseIconButton
            size="md"
            aria-label="Close"
            onClick={requestClose}
            className="ml-2"
          />
        ) : null}
      </header>

      <main ref={stepBodyRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          key={step}
          className={`mx-auto flex w-full max-w-[520px] flex-col gap-7 px-6 pt-10 pb-14 ${stepAnimationClass}`}
        >
          {stepIndex > 0 ? (
            <button
              type="button"
              onClick={goBack}
              className="
                -ml-1.5 inline-flex h-7 w-fit items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-[color:var(--text-subtle)]
                transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            >
              <svg className="icon-sm" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M7.5 3L4.5 6L7.5 9"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Back
            </button>
          ) : null}
          <header className="flex flex-col gap-1.5">
            {step === 'workspace' ? (
              <div
                aria-hidden="true"
                className="logo-rise mx-auto mb-6 flex flex-col items-center gap-3"
              >
                <div
                  ref={logoOuterRef}
                  className="h-16 w-16"
                  style={{ perspective: '420px' }}
                >
                  <div
                    ref={logoInnerRef}
                    className="h-full w-full will-change-transform"
                    style={{
                      transformStyle: 'preserve-3d',
                      transition: 'transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
                      filter: 'drop-shadow(0 6px 14px rgba(0, 0, 0, 0.45))',
                    }}
                  >
                    <MulticodeMark
                      className="h-full w-full"
                      variant="gradient"
                      title="Multicode"
                    />
                  </div>
                </div>
                <MulticodeWordmark className="h-5 text-[color:var(--text-strong)]" />
              </div>
            ) : null}
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="text-[22px] font-semibold leading-7 tracking-tight text-[color:var(--text-strong)] outline-none"
            >
              {stepHeading.title}
            </h3>
            <p className="text-[13px] leading-5 text-[color:var(--text-muted)]">{stepHeading.subtitle}</p>
          </header>

          {step === 'workspace' ? (
            <WorkspaceStep
              name={name}
              onChangeName={handleChangeName}
              folderPath={folderPath}
              onPickFolder={() => void pickFolder()}
              onSelectRecent={handleSelectFolder}
              recentFolders={recentFolders}
              folderHints={folderHints}
              inputRef={nameInputRef}
            />
          ) : null}

          {step === 'mode' ? (
            <ModeStep
              mode={mode}
              onSelect={handleSelectMode}
              folderPath={folderPath}
              folderHint={folderPath ? folderHints.get(folderPath) ?? null : null}
            />
          ) : null}

          {step === 'mcp-servers' ? (
            <McpServersStep
              mcpCatalog={integrationsMcpCatalog}
              mcpSettings={mcpSettings ?? null}
              onToggleMcp={toggleMcpInWizard}
              message={integrationsMessage}
            />
          ) : null}

          {step === 'skill-packs' ? (
            <SkillPacksStep
              skillPackCatalog={integrationsSkillPackCatalog}
              selectedSkillPackIds={selectedSkillPackIds}
              onToggleSkillPack={toggleSkillPackInWizard}
              message={integrationsMessage}
            />
          ) : null}

          {step === 'standard-layout' ? (
            <StandardLayoutStep layoutId={layoutId} onChange={setLayoutId} />
          ) : null}

          {step === 'multiloop-goal' ? (
            <MultiloopGoalStep
              goal={mlGoal}
              onChangeGoal={(value) => {
                setMlGoal(value)
                setMlError(null)
              }}
              cliPermissionPreset={cliPermissionPreset}
              onChangeCliPermissionPreset={setCliPermissionPreset}
              error={mlError}
            />
          ) : null}

          {step === 'sprintengine-team' ? (
            <SprintEngineTeamStep
              access={sprintEngineAccess}
              onSignIn={() => void startLogin()}
              folderPath={folderPath}
              isScanning={folderScan.isScanning}
              existingTeams={folderScan.result.teams}
              planOptions={folderScan.result.plans}
              path={sePath}
              onChangePath={(p) => {
                setSePath(p)
                setSeExistingTeam(null)
                setSeAgentCliOverrides({})
                if (p !== 'plan') {
                  setSePlanPath('')
                  setSePlanContent(null)
                  setSeSourcePlanKind('unknown')
                  setSeSourceBundle(null)
                }
                setSePlanError(null)
              }}
              planPath={sePlanPath}
              onSelectPlan={(p) => void handleSelectPlan(p)}
              sourcePlanKind={seSourcePlanKind}
              onChangeSourcePlanKind={setSeSourcePlanKind}
              sourceBundle={seSourceBundle}
              onChangeSourceBundleKind={(index, kind) => {
                setSeSourceBundle((current) => {
                  if (!current) return current
                  return current.map((item, itemIndex) => itemIndex === index ? { ...item, kind } : item)
                })
                const item = seSourceBundle?.[index]
                if (
                  item?.sourcePath === sePlanPath
                  && (kind === 'product_plan' || kind === 'architect_plan' || kind === 'unknown')
                ) {
                  setSeSourcePlanKind(kind)
                }
              }}
              onClearSourceBundle={() => {
                setSePlanPath('')
                setSePlanContent(null)
                setSeSourcePlanKind('unknown')
                setSeSourceBundle(null)
                setSePlanError(null)
              }}
              planError={sePlanError}
              existingTeamSlug={seExistingTeam?.slug ?? ''}
              onSelectExistingTeam={handleSelectExistingTeam}
              teamName={seTeamName}
              onChangeTeamName={(value) => {
                setSeExistingTeam(null)
                setSeAgentCliOverrides({})
                setSeTeamName(value)
                setSeTeamNameTouched(true)
                setSePlanError(null)
              }}
              goal={seGoal}
              onChangeGoal={(value) => {
                setSeExistingTeam(null)
                setSeAgentCliOverrides({})
                setSeGoal(value)
                setSePlanError(null)
              }}
            />
          ) : null}

          {step === 'guided-idea' ? (
            <GuidedIdeaStep
              idea={guidedIdea}
              hasUi={guidedHasUi}
              onChangeIdea={(value) => {
                setGuidedIdea(value)
                setGuidedError(null)
              }}
              onChangeHasUi={(value) => {
                setGuidedHasUi(value)
                if (value === 'no') setGuidedWantsFrontend(false)
                if (value === 'yes') setGuidedWantsFrontend(true)
                setGuidedError(null)
              }}
              wantsProductDiscussion={guidedWantsProduct}
              wantsArchitectureDiscussion={guidedWantsArchitecture}
              wantsFrontendDiscussion={guidedWantsFrontend}
              roleCliDefaults={guidedRoleCliDefaults}
              onChangeWantsProductDiscussion={setGuidedWantsProduct}
              onChangeWantsArchitectureDiscussion={setGuidedWantsArchitecture}
              onChangeWantsFrontendDiscussion={setGuidedWantsFrontend}
              onSetRoleCli={setGuidedRoleCli}
              folderPath={folderPath}
              error={guidedError}
            />
          ) : null}

          {step === 'sprintengine-roster' ? (
            <SprintEngineRosterStep
              access={sprintEngineAccess}
              onSignIn={() => void startLogin()}
              roleCounts={visibleSprintEngineRoleCounts}
              roleCliDefaults={seRoleCliDefaults}
              cliOptions={sprintEngineCliOptions}
              registry={seRoleRegistry}
              registryStatus={seRoleRegistryStatus}
              disabledRoleIds={effectiveSprintEngineDisabledRoleIds}
              rosterDisabled={seExistingTeam != null}
              onSetRoleCount={setRoleCount}
              onSetRoleCli={setRoleCli}
              automationMode={seAutomationMode}
              onChangeAutomationMode={setSeAutomationMode}
              cliPermissionPreset={cliPermissionPreset}
              onChangeCliPermissionPreset={setCliPermissionPreset}
              totalAgents={totalAgents}
              hasExistingTeam={seExistingTeam != null}
              existingTeamName={seExistingTeam?.displayName ?? null}
              createError={sePlanError}
            />
          ) : null}

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="min-w-0 flex-1 truncate text-[12px] leading-5 text-[color:var(--text-subtle)]">
              {blockingMessage}
            </p>
            <button
              type="button"
              onClick={goNext}
              disabled={!canAdvanceFromCurrent || isCreating}
              className="
                inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--accent-primary)] px-4 text-[13px] font-semibold text-[color:var(--bg-app)]
                transition-colors hover:bg-[color:var(--accent-primary-hover)]
                disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              "
            >
              {primaryLabel}
              {!isLastStep ? (
                <svg className="icon-sm" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M4.5 3L7.5 6L4.5 9"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </button>
          </div>
        </div>
      </main>
      <GuidedBriefCloseConfirmation
        open={closeConfirmation}
        stage={guidedRuntimeState?.stage ?? null}
        onCancel={() => setCloseConfirmation(false)}
        onConfirm={() => {
          setCloseConfirmation(false)
          // Tear down any running guided-brief PTYs — runtime state is about to
          // be discarded, so the session ids would otherwise leak.
          const strategistId = guidedRuntimeState?.strategistSessionId
          const architectId = guidedRuntimeState?.architectSessionId
          const designerId = guidedRuntimeState?.designerSessionId
          if (strategistId) void window.api.terminalKill(strategistId).catch(() => {})
          if (architectId) void window.api.terminalKill(architectId).catch(() => {})
          if (designerId) void window.api.terminalKill(designerId).catch(() => {})
          onClose()
        }}
      />
    </section>
  )
}


const FieldLabel = Field.Label

function WorkspaceStep({
  name,
  onChangeName,
  folderPath,
  onPickFolder,
  onSelectRecent,
  recentFolders,
  folderHints,
  inputRef,
}: {
  name: string
  onChangeName: (value: string) => void
  folderPath: string | null
  onPickFolder: () => void
  onSelectRecent: (path: string) => void
  recentFolders: string[]
  folderHints: ReturnType<typeof useFolderHints>
  inputRef: React.MutableRefObject<HTMLInputElement | null>
}) {
  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <FieldLabel>Workspace name</FieldLabel>
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => onChangeName(event.target.value)}
          placeholder="my-workspace"
          className="
            block h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5
            text-[14px] text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
      </label>

      <div className="flex flex-col gap-2">
        <FieldLabel>Folder</FieldLabel>
        <button
          type="button"
          onClick={onPickFolder}
          className="
            flex h-11 w-full items-center gap-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5
            text-left transition-colors hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]
            focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
          "
        >
          <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3.75 7.5C3.75 6.39543 4.64543 5.5 5.75 5.5H9.5L11.5 7.5H18.25C19.3546 7.5 20.25 8.39543 20.25 9.5V16.25C20.25 17.3546 19.3546 18.25 18.25 18.25H5.75C4.64543 18.25 3.75 17.3546 3.75 16.25V7.5Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${
              folderPath ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-disabled)]'
            }`}
          >
            {folderPath ?? 'Choose a folder…'}
          </span>
          <span className="shrink-0 text-[12px] font-semibold text-[color:var(--text-muted)]">Browse</span>
        </button>
      </div>

      {recentFolders.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">
            Recent
          </div>
          <div className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto pr-1">
            {recentFolders.map((recent) => {
              const hint = folderHints.get(recent)
              const hints: Array<'sprintengine' | 'multiloop'> = []
              if (hint?.hasSprintEngineTeam) hints.push('sprintengine')
              if (hint?.hasMultiloop) hints.push('multiloop')
              return (
                <RecentFolderRow
                  key={recent}
                  path={recent}
                  active={isSameFolder(folderPath, recent)}
                  hints={hints}
                  onSelect={onSelectRecent}
                />
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ModeStep({
  mode,
  onSelect,
  folderPath,
  folderHint,
}: {
  mode: CreationMode
  onSelect: (mode: CreationMode) => void
  folderPath: string | null
  folderHint: { hasSprintEngineTeam?: boolean; hasMultiloop?: boolean } | null
}) {
  const suggested: CreationMode | null = (() => {
    if (!folderHint) return null
    if (folderHint.hasSprintEngineTeam) return 'sprintengine'
    if (folderHint.hasMultiloop) return 'multiloop'
    return null
  })()

  return (
    <div className="flex flex-col gap-3">
      {folderPath && suggested ? (
        <p className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
          We found a saved{' '}
          <span className="font-semibold text-[color:var(--text-strong)]">{labelFor(suggested)}</span>{' '}
          team in this folder. {mode === suggested ? 'Selected for you.' : 'Select it to load.'}
        </p>
      ) : null}
      <div role="radiogroup" aria-label="Workspace mode" className="grid grid-cols-2 gap-2.5">
        {MODES.map((m) => (
          <ModeCard key={m} mode={m} active={mode === m} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function McpServersStep({
  mcpCatalog,
  mcpSettings,
  onToggleMcp,
  message,
}: {
  mcpCatalog: McpCatalogServer[]
  mcpSettings: { servers: Record<string, { enabled: boolean }> } | null
  onToggleMcp: (server: McpCatalogServer) => void
  message: string | null
}) {
  const selectedCount = mcpCatalog.reduce(
    (count, server) => count + (mcpSettings?.servers[server.id]?.enabled ? 1 : 0),
    0,
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          Selected servers are saved to this project and synced to agent configs from Settings.
        </p>
        {mcpCatalog.length > 0 ? (
          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </div>
      {mcpCatalog.length === 0 ? (
        <p className="text-[11px] text-[color:var(--text-subtle)]">Catalog loading…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 min-[760px]:grid-cols-2">
          {mcpCatalog.map((server) => {
            const enabled = Boolean(mcpSettings?.servers[server.id]?.enabled)
            return (
              <li key={server.id}>
                <button
                  type="button"
                  onClick={() => onToggleMcp(server)}
                  aria-pressed={enabled}
                  className={`
                    grid h-full min-h-[58px] w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md border px-3 py-2 text-left
                    transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                    ${enabled
                      ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                      : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
                  `}
                >
                  <span
                    aria-hidden
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-sm border ${
                      enabled
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
                        : 'border-[color:var(--border-default)]'
                    }`}
                  >
                    {enabled ? (
                      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="1.5,5 4,7.5 8.5,2.5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                      {server.name}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]">
                      {server.transport} · {server.category ?? 'Other'}
                    </span>
                  </span>
                  {server.recommendedScope === 'user' ? (
                    <span className="rounded-sm border border-[color:var(--border-default)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--text-subtle)]">
                      user
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {message ? (
        <p className="text-[11px] leading-4 text-[color:var(--text-muted)]">{message}</p>
      ) : null}
    </div>
  )
}

function SkillPacksStep({
  skillPackCatalog,
  selectedSkillPackIds,
  onToggleSkillPack,
  message,
}: {
  skillPackCatalog: SkillPackCatalogEntry[]
  selectedSkillPackIds: Set<string>
  onToggleSkillPack: (pack: SkillPackCatalogEntry) => void
  message: string | null
}) {
  const selectedCount = skillPackCatalog.reduce(
    (count, pack) => count + (selectedSkillPackIds.has(pack.id) ? 1 : 0),
    0,
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          Each selected pack runs <code className="font-mono">npx skills add</code> after creation,
          writing into whichever harness directories already exist.
        </p>
        {skillPackCatalog.length > 0 ? (
          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </div>
      {skillPackCatalog.length === 0 ? (
        <p className="text-[11px] text-[color:var(--text-subtle)]">Catalog loading…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 min-[760px]:grid-cols-2">
          {skillPackCatalog.map((pack) => {
            const selected = selectedSkillPackIds.has(pack.id)
            return (
              <li key={pack.id}>
                <button
                  type="button"
                  onClick={() => onToggleSkillPack(pack)}
                  aria-pressed={selected}
                  className={`
                    grid h-full min-h-[58px] w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md border px-3 py-2 text-left
                    transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                    ${selected
                      ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                      : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
                  `}
                >
                  <span
                    aria-hidden
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-sm border ${
                      selected
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
                        : 'border-[color:var(--border-default)]'
                    }`}
                  >
                    {selected ? (
                      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="1.5,5 4,7.5 8.5,2.5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                      {pack.name}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]">
                      {pack.slug}
                    </span>
                  </span>
                  {pack.recommended || pack.version ? (
                    <span className="flex max-w-[92px] flex-col items-end gap-1">
                      {pack.recommended ? (
                        <span className="rounded-sm border border-[color:var(--border-default)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--text-subtle)]">
                          rec
                        </span>
                      ) : null}
                      {pack.version ? (
                        <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">
                          v{pack.version}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {message ? (
        <p className="text-[11px] leading-4 text-[color:var(--text-muted)]">{message}</p>
      ) : null}
    </div>
  )
}

function StandardLayoutStep({
  layoutId,
  onChange,
}: {
  layoutId: string
  onChange: (id: string) => void
}) {
  return (
    <div role="radiogroup" aria-label="IDE layout" className="flex flex-col gap-1.5">
      {LAYOUT_TEMPLATES.map((template) => {
        const active = template.id === layoutId
        return (
          <button
            key={template.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(template.id)}
            className={`
              grid w-full grid-cols-[18px_minmax(0,1fr)] items-start gap-3 rounded-md border px-3.5 py-3 text-left
              transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
              ${active
                ? 'border-[color:var(--color-6)] bg-[color:var(--bg-surface-raised)]'
                : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
            `}
          >
            <span
              className={`mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full border ${
                active ? 'border-[color:var(--text-strong)] bg-[color:var(--text-strong)]' : 'border-[color:var(--color-6)]'
              }`}
              aria-hidden="true"
            >
              {/* design-tokens-allow: inner glyph of a custom radio control — not a status dot */}
              {active ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" /> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">{template.name}</span>
              <span className="mt-0.5 block text-[12px] leading-5 text-[color:var(--text-muted)]">
                {template.description}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function MultiloopGoalStep({
  goal,
  onChangeGoal,
  cliPermissionPreset,
  onChangeCliPermissionPreset,
  error,
}: {
  goal: string
  onChangeGoal: (value: string) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <FieldLabel>Final goal</FieldLabel>
        <textarea
          value={goal}
          onChange={(event) => onChangeGoal(event.target.value)}
          placeholder="What outcome should this loop reach?"
          autoFocus
          className="
            min-h-[140px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5 py-3
            text-[14px] leading-6 text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
      </label>
      <div className="flex flex-col gap-2">
        <FieldLabel>Run settings</FieldLabel>
        <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <CliPermissionPresetRow
            preset={cliPermissionPreset}
            onChange={onChangeCliPermissionPreset}
          />
        </div>
      </div>
      {error ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function GuidedIdeaStep({
  idea,
  hasUi,
  onChangeIdea,
  onChangeHasUi,
  wantsProductDiscussion,
  wantsArchitectureDiscussion,
  wantsFrontendDiscussion,
  roleCliDefaults,
  onChangeWantsProductDiscussion,
  onChangeWantsArchitectureDiscussion,
  onChangeWantsFrontendDiscussion,
  onSetRoleCli,
  folderPath,
  error,
}: {
  idea: string
  hasUi: GuidedBriefHasUi | null
  onChangeIdea: (value: string) => void
  onChangeHasUi: (value: GuidedBriefHasUi) => void
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  roleCliDefaults: GuidedBriefRoleCliDefaults
  onChangeWantsProductDiscussion: (value: boolean) => void
  onChangeWantsArchitectureDiscussion: (value: boolean) => void
  onChangeWantsFrontendDiscussion: (value: boolean) => void
  onSetRoleCli: (role: keyof GuidedBriefRoleCliDefaults, cli: AgentCli) => void
  folderPath: string | null
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-2">
        <FieldLabel>Rough idea</FieldLabel>
        <textarea
          value={idea}
          onChange={(event) => onChangeIdea(event.target.value)}
          placeholder="A shift-trading app where café staff can swap shifts without texting the manager."
          autoFocus
          className="
            min-h-[140px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5 py-3
            text-[14px] leading-6 text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
        <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          Plain English. Spelling doesn’t matter.
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <FieldLabel>Will people use it on a screen?</FieldLabel>
        <div role="radiogroup" aria-label="App surface" className="grid grid-cols-2 gap-2.5">
          <GuidedHasUiChoice
            active={hasUi === 'yes'}
            title="Yes, it has a UI"
            body="App, dashboard, mobile screen, internal tool."
            onSelect={() => onChangeHasUi('yes')}
          />
          <GuidedHasUiChoice
            active={hasUi === 'no'}
            title="No, script or service"
            body="CLI, API, automation — runs in the background."
            onSelect={() => onChangeHasUi('no')}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabel>Guided discussions</FieldLabel>
        <div className="flex flex-col gap-2">
          <GuidedRoleToggle
            checked={wantsProductDiscussion}
            title="Product strategist"
            body="Sharpens the product brief before planning."
            cli={roleCliDefaults.product}
            onChangeCli={(cli) => onSetRoleCli('product', cli)}
            onChange={onChangeWantsProductDiscussion}
          />
          <GuidedRoleToggle
            checked={wantsArchitectureDiscussion}
            title="Architect"
            body="Interviews through architecture decisions and writes architecture/plan.md."
            cli={roleCliDefaults.architect}
            onChangeCli={(cli) => onSetRoleCli('architect', cli)}
            onChange={onChangeWantsArchitectureDiscussion}
          />
          <GuidedRoleToggle
            checked={hasUi === 'yes' && wantsFrontendDiscussion}
            disabled={hasUi !== 'yes'}
            title="Frontend engineer"
            body={hasUi === 'yes' ? 'Designs UI direction and reviewable mockups.' : 'Available only for visual apps.'}
            cli={roleCliDefaults.frontend}
            onChangeCli={(cli) => onSetRoleCli('frontend', cli)}
            onChange={onChangeWantsFrontendDiscussion}
          />
        </div>
      </div>

      {folderPath ? (
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          Idea seed will be written to{' '}
          <span className="font-mono text-[color:var(--text-default)]">product/idea-seed.md</span>{' '}
          in the selected folder.
        </p>
      ) : null}

      {error ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function GuidedRoleToggle({
  checked,
  disabled = false,
  title,
  body,
  cli,
  onChange,
  onChangeCli,
}: {
  checked: boolean
  disabled?: boolean
  title: string
  body: string
  cli: AgentCli
  onChange: (value: boolean) => void
  onChangeCli: (cli: AgentCli) => void
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] px-3 py-2.5 ${
        disabled ? 'opacity-55' : 'hover:border-[color:var(--color-5)]'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-[color:var(--text-strong)]">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-4 text-[color:var(--text-muted)]">{body}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Select<AgentCli>
          ariaLabel={`${title} CLI`}
          items={[
            { value: 'codex', label: 'Codex' },
            { value: 'claude', label: 'Claude' },
          ]}
          value={cli}
          onChange={onChangeCli}
          disabled={disabled || !checked}
          className="w-[140px]"
        />
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-[color:var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-primary)] disabled:cursor-not-allowed"
        />
      </span>
    </div>
  )
}

function GuidedHasUiChoice({
  active,
  title,
  body,
  onSelect,
}: {
  active: boolean
  title: string
  body: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={`
        relative flex h-[88px] w-full flex-col items-start gap-1.5 overflow-hidden rounded-md border p-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        ${active
          ? 'border-[color:var(--accent-primary-soft-strong)] bg-[color:var(--accent-primary-soft)]'
          : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[3px] ${active ? 'bg-[color:var(--accent-primary)]' : 'bg-transparent'}`}
      />
      <span className="text-[13px] font-semibold leading-4 text-[color:var(--text-strong)]">
        {title}
      </span>
      <span className="text-[12px] leading-4 text-[color:var(--text-muted)]">{body}</span>
    </button>
  )
}

type SprintEngineAccessState = {
  allowed: boolean
  title: string
  body: string
  action: 'login'
}

function getSprintEngineAccessState(authState: MulticodeAuthState): SprintEngineAccessState {
  if (!authState.authenticated) {
    return {
      allowed: false,
      title: 'Sprint Engine is locked while signed out.',
      body: 'Sign in to create or supervise local Sprint Engine specialist workflows.',
      action: 'login',
    }
  }
  return {
    allowed: true,
    title: 'Sprint Engine is available.',
    body: 'This signed-in Multicode session can create local Sprint Engine workflows.',
    action: 'login',
  }
}

function SprintEngineAccessNotice({
  access,
  onSignIn,
}: {
  access: SprintEngineAccessState
  onSignIn: () => void
}) {
  return (
    <div
      className="rounded-md border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-4 py-4"
      role="status"
      aria-live="polite"
    >
      <div className="text-[13px] font-semibold text-[color:var(--tone-warn)]">{access.title}</div>
      <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">{access.body}</p>
      <button
        type="button"
        onClick={onSignIn}
        className="
          mt-3 inline-flex h-8 items-center justify-center rounded-md bg-[color:var(--text-strong)] px-3
          text-[12px] font-semibold text-[color:var(--bg-app)] transition-colors hover:bg-white
          focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        "
      >
        Sign in
      </button>
    </div>
  )
}

function SprintEngineTeamStep(props: {
  access: SprintEngineAccessState
  onSignIn: () => void
  folderPath: string | null
  isScanning: boolean
  existingTeams: ExistingTeam[]
  planOptions: Array<{ path: string; relativePath: string }>
  path: SprintEnginePath
  onChangePath: (path: SprintEnginePath) => void
  planPath: string
  onSelectPlan: (sourcePath: string) => void
  sourcePlanKind: SprintEngineSourcePlanKind
  onChangeSourcePlanKind: (kind: SprintEngineSourcePlanKind) => void
  sourceBundle: SprintEngineSourceBundleItem[] | null
  onChangeSourceBundleKind: (index: number, kind: SprintEngineSourceBundleKind) => void
  onClearSourceBundle: () => void
  planError: string | null
  existingTeamSlug: string
  onSelectExistingTeam: (slug: string) => void
  teamName: string
  onChangeTeamName: (value: string) => void
  goal: string
  onChangeGoal: (value: string) => void
}) {
  const {
    access,
    onSignIn,
    folderPath,
    isScanning,
    existingTeams,
    planOptions,
    path,
    onChangePath,
    planPath,
    onSelectPlan,
    sourcePlanKind,
    onChangeSourcePlanKind,
    sourceBundle,
    onChangeSourceBundleKind,
    onClearSourceBundle,
    planError,
    existingTeamSlug,
    onSelectExistingTeam,
    teamName,
    onChangeTeamName,
    goal,
    onChangeGoal,
  } = props

  const [planTypeEditing, setPlanTypeEditing] = useState(false)
  useEffect(() => {
    setPlanTypeEditing(false)
  }, [planPath])

  if (!access.allowed) {
    return <SprintEngineAccessNotice access={access} onSignIn={onSignIn} />
  }

  const planAvailable = planOptions.length > 0
  const teamAvailable = existingTeams.length > 0
  const planKindLabel = SOURCE_PLAN_KIND_LABELS[sourcePlanKind]
  const hasSourceBundle = Boolean(sourceBundle?.length)

  return (
    <div className="flex flex-col gap-5">
      <div
        role="radiogroup"
        aria-label="Sprint Engine starting point"
        className="flex flex-col gap-1.5"
      >
        <PathRadio
          checked={path === 'new'}
          label="Start a new team"
          hint="Define an objective, pick specialists, run from scratch."
          onSelect={() => onChangePath('new')}
        />
        <PathRadio
          checked={path === 'existing'}
          disabled={!teamAvailable}
          label="Load an existing team"
          hint={
            isScanning
              ? 'Scanning the folder for saved teams…'
              : teamAvailable
                ? `${existingTeams.length} team${existingTeams.length === 1 ? '' : 's'} saved in this folder.`
                : !folderPath
                  ? 'Pick a folder to detect saved teams.'
                  : 'No saved teams in this folder.'
          }
          onSelect={() => onChangePath('existing')}
        />
        <PathRadio
          checked={path === 'plan'}
          disabled={!planAvailable && !planPath}
          label="Source from files"
          hint={
            isScanning
              ? 'Scanning the folder for source files…'
              : planAvailable
                ? `${planOptions.length} source file${planOptions.length === 1 ? '' : 's'} available.`
                : !folderPath
                  ? 'Pick a folder to detect source files.'
                  : 'No source files found.'
          }
          onSelect={() => onChangePath('plan')}
        />
      </div>

      {path === 'existing' ? (
        <div className="flex flex-col gap-2">
          <FieldLabel>Team</FieldLabel>
          <Select<string>
            ariaLabel="Team"
            items={existingTeams.map((team) => ({ value: team.slug, label: team.displayName }))}
            value={existingTeamSlug || null}
            onChange={onSelectExistingTeam}
            disabled={isScanning || existingTeams.length === 0}
            placeholder="Select a team…"
            className="w-full"
          />
        </div>
      ) : null}

      {path === 'plan' ? (
        <div className="flex flex-col gap-3">
          {!hasSourceBundle ? (
            <div className="flex flex-col gap-2">
              <FieldLabel>Source file</FieldLabel>
              <Select<string>
                ariaLabel="Source file"
                items={planOptions.map((plan) => ({ value: plan.path, label: plan.relativePath }))}
                value={planPath || null}
                onChange={onSelectPlan}
                disabled={!folderPath || isScanning}
                placeholder="Select a source file…"
                className="w-full"
              />
            </div>
          ) : null}
          {planPath && !hasSourceBundle ? (
            planTypeEditing ? (
              <div className="flex flex-col gap-2">
                <FieldLabel>Plan type</FieldLabel>
                <Select<SprintEngineSourcePlanKind>
                  ariaLabel="Plan type"
                  items={SOURCE_PLAN_KIND_OPTIONS}
                  value={sourcePlanKind}
                  onChange={(value) => {
                    onChangeSourcePlanKind(value)
                    setPlanTypeEditing(false)
                  }}
                  className="w-full"
                />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
                <span>Plan type</span>
                <span aria-hidden="true">·</span>
                <span className="text-[color:var(--text-default)]">{planKindLabel}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setPlanTypeEditing(true)}
                  aria-label="Change plan type"
                  className="
                    rounded-sm text-[color:var(--text-default)] underline-offset-2
                    hover:underline focus:outline-none focus-visible:ring-2
                    focus-visible:ring-[color:var(--accent-primary)]
                  "
                >
                  Change
                </button>
              </div>
            )
          ) : null}
          {hasSourceBundle ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Source bundle</FieldLabel>
                <button
                  type="button"
                  onClick={onClearSourceBundle}
                  className="
                    rounded-sm text-[12px] leading-5 text-[color:var(--text-muted)] underline-offset-2
                    hover:text-[color:var(--text-default)] hover:underline focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  "
                >
                  Clear sources
                </button>
              </div>
              <div className="rounded-md border border-[color:var(--border-default)]">
                {sourceBundle?.map((item, index) => {
                  const label = SOURCE_BUNDLE_KIND_LABELS[item.kind] ?? item.kind.replace(/_/g, ' ')
                  return (
                    <div
                      key={`${item.sourceRelativePath}-${index}`}
                      className="
                        grid grid-cols-[minmax(0,1fr)_150px] items-center gap-3 border-b
                        border-[color:var(--border-subtle)] px-3 py-2 last:border-b-0
                      "
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[12px] leading-5 text-[color:var(--text-default)]">
                          {item.sourceRelativePath}
                        </div>
                        <div className="text-[11px] leading-4 text-[color:var(--text-muted)]">
                          {label}
                        </div>
                      </div>
                      <Select<SprintEngineSourceBundleKind>
                        ariaLabel={`Source type for ${item.sourceRelativePath}`}
                        items={SOURCE_BUNDLE_KIND_OPTIONS}
                        value={item.kind}
                        onChange={(value) => onChangeSourceBundleKind(index, value)}
                        className="w-full"
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {planError ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {planError}
        </div>
      ) : null}

      <label className="flex flex-col gap-2">
        <FieldLabel>Team name</FieldLabel>
        <input
          value={teamName}
          onChange={(event) => onChangeTeamName(event.target.value)}
          placeholder="Interface Team"
          className="
            block h-11 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5
            text-[14px] font-medium text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
      </label>

      <label className="flex flex-col gap-2">
        <FieldLabel>Objective</FieldLabel>
        <textarea
          value={goal}
          onChange={(event) => onChangeGoal(event.target.value)}
          placeholder="What outcome should this team deliver?"
          className="
            min-h-[120px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5 py-3
            text-[14px] leading-6 text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
      </label>
    </div>
  )
}

function SprintEngineRosterStep(props: {
  access: SprintEngineAccessState
  onSignIn: () => void
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  cliOptions: Array<{ value: AgentCli; label: string }>
  registry: SprintEngineRoleRegistry | null
  registryStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  disabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
  rosterDisabled: boolean
  onSetRoleCount: (role: SprintEngineRoleId, count: number) => void
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  totalAgents: number
  hasExistingTeam: boolean
  existingTeamName: string | null
  createError: string | null
}) {
  const {
    access,
    onSignIn,
    roleCounts,
    roleCliDefaults,
    cliOptions,
    registry,
    registryStatus,
    disabledRoleIds,
    rosterDisabled,
    onSetRoleCount,
    onSetRoleCli,
    automationMode,
    onChangeAutomationMode,
    cliPermissionPreset,
    onChangeCliPermissionPreset,
    totalAgents,
    hasExistingTeam,
    existingTeamName,
    createError,
  } = props

  if (!access.allowed) {
    return <SprintEngineAccessNotice access={access} onSignIn={onSignIn} />
  }

  return (
    <div className="flex flex-col gap-5">
      {hasExistingTeam ? (
        <p className="rounded-md border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
          Loading <span className="font-semibold">{existingTeamName}</span> — roster size is read-only; CLI choices can be changed before launch.
        </p>
      ) : null}

      {createError ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {createError}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <FieldLabel>Roster</FieldLabel>
          <span className="text-[11px] tabular-nums text-[color:var(--text-muted)]">
            {registryStatus === 'loading'
              ? 'Loading roles'
              : `${totalAgents} specialist${totalAgents === 1 ? '' : 's'}`}
          </span>
        </div>
        <SprintEngineRosterTable
          roleCounts={roleCounts}
          roleCliDefaults={roleCliDefaults}
          cliOptions={cliOptions}
          registry={registry}
          disabledRoleIds={disabledRoleIds}
          countDisabled={rosterDisabled}
          cliDisabled={false}
          onSetCount={onSetRoleCount}
          onSetCli={onSetRoleCli}
        />
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabel>Run settings</FieldLabel>
        <div className="overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <CliPermissionPresetRow
            preset={cliPermissionPreset}
            onChange={onChangeCliPermissionPreset}
          />
          <div className="flex flex-col gap-2 border-t border-[color:var(--border-default)] px-3.5 py-3">
            <div>
              <span className="block text-[13px] font-semibold text-[color:var(--text-strong)]">Automation</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">
                How Sprint Engine should continue after this workspace opens.
              </span>
            </div>
            <div className="grid gap-2" role="radiogroup" aria-label="Sprint Engine automation mode">
              {sprintEngineAutomationModeOptions.map((option) => (
                <PathRadio
                  key={option.value}
                  checked={automationMode === option.value}
                  label={option.label}
                  hint={option.hint}
                  onSelect={() => onChangeAutomationMode(option.value)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function planSourcedErrorMessage(error: SprintEnginePlanSourcedError): string {
  switch (error.code) {
    case 'missing-folder':
      return 'Pick a folder before creating from a plan.'
    case 'missing-plan-option':
      return 'Selected plan is no longer available. Pick it again on the previous step.'
    case 'missing-plan-content':
      return 'Plan content was not loaded. Re-select the plan on the previous step.'
    case 'missing-team-name':
      return 'Add a team name on the previous step.'
    case 'missing-goal':
      return 'Add an objective on the previous step.'
    case 'plan-not-on-disk':
      return 'Selected source file is not available.'
    case 'team-exists':
      return 'A Sprint Engine team with this name already exists.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the Sprint Engine workspace.'
  }
}

function guidedBriefStartBuildErrorMessage(error: GuidedBriefStartBuildError): string {
  switch (error.code) {
    case 'missing-product-brief':
      return 'Accept the product brief before starting the build.'
    case 'missing-architecture-plan':
      return 'Accept the architecture plan before starting the build.'
    case 'missing-ui-direction-or-mockups':
      return 'Accept the UI direction and mockups before starting the build.'
    case 'team-exists':
      return 'A Sprint Engine team with this name already exists.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the Sprint Engine workspace.'
  }
}

function labelFor(mode: CreationMode): string {
  switch (mode) {
    case 'standard':
      return 'Standard'
    case 'switchboard':
      return 'Switchboard'
    case 'sprintengine':
      return 'Sprint Engine'
    case 'multiloop':
      return 'Multiloop'
    case 'guided-brief':
      return 'Guided brief'
  }
}

function createLabelFor(mode: CreationMode, isCreating: boolean, hasExistingTeam: boolean): string {
  if (isCreating) return 'Creating…'
  if (mode === 'sprintengine' && hasExistingTeam) return 'Load team'
  switch (mode) {
    case 'sprintengine':
      return 'Create Sprint Engine'
    case 'switchboard':
      return 'Create Switchboard'
    case 'multiloop':
      return 'Create Multiloop'
    case 'guided-brief':
      return 'Continue'
    case 'standard':
      return 'Create workspace'
  }
}

function isStepReady(
  step: StepId,
  readiness: {
    workspaceStepReady: boolean
    standardLayoutStepReady: boolean
    multiloopGoalReady: boolean
    sprintEngineTeamReady: boolean
    sprintEngineRosterReady: boolean
    guidedIdeaReady: boolean
  },
): boolean {
  switch (step) {
    case 'workspace':
      return readiness.workspaceStepReady
    case 'mode':
      return true
    case 'mcp-servers':
      return true
    case 'skill-packs':
      return true
    case 'standard-layout':
      return readiness.standardLayoutStepReady
    case 'multiloop-goal':
      return readiness.multiloopGoalReady
    case 'sprintengine-team':
      return readiness.sprintEngineTeamReady
    case 'sprintengine-roster':
      return readiness.sprintEngineRosterReady
    case 'guided-idea':
      return readiness.guidedIdeaReady
  }
}

function getStepBlockingMessage(args: {
  step: StepId
  mode: CreationMode
  folderPath: string | null
  name: string
  mlGoal: string
  sprintEngineAccess: SprintEngineAccessState
  sePath: SprintEnginePath
  sePlanReady: boolean
  seExistingTeam: ExistingTeam | null
  seObjectiveComplete: boolean
  totalAgents: number
  guidedIdea: string
  guidedHasUi: GuidedBriefHasUi | null
}): string {
  const {
    step,
    mode,
    folderPath,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seObjectiveComplete,
    totalAgents,
    guidedIdea,
    guidedHasUi,
  } = args

  switch (step) {
    case 'workspace':
      if (!folderPath && !name.trim()) return 'Add a name and choose a folder.'
      if (!folderPath) return 'Choose a folder to continue.'
      if (!name.trim()) return 'Give the workspace a name.'
      return 'Press Continue to choose a mode.'
    case 'mode':
      return `Continue with ${labelFor(mode)}, or pick another.`
    case 'mcp-servers':
      return 'Pick MCP servers, or skip to add them later from Settings.'
    case 'skill-packs':
      return 'Pick skill packs, or skip to add them later from Settings.'
    case 'standard-layout':
      return 'Pick a layout, then create.'
    case 'multiloop-goal':
      if (!mlGoal.trim()) return 'Describe the loop goal to create.'
      return 'Ready to create the loop.'
    case 'sprintengine-team':
      if (!sprintEngineAccess.allowed) return 'Sign in to use Sprint Engine mode.'
      if (sePath === 'plan' && !sePlanReady) return 'Select a markdown plan.'
      if (seExistingTeam) return 'Existing team loaded — continue.'
      if (!seObjectiveComplete) return 'Add a team name and an objective.'
      return 'Continue to the roster.'
    case 'sprintengine-roster':
      if (!sprintEngineAccess.allowed) return 'Sign in to use Sprint Engine mode.'
      if (seExistingTeam) return 'Ready to load team.'
      if (totalAgents === 0) return 'Add at least one specialist.'
      return 'Ready to create.'
    case 'guided-idea':
      if (!guidedIdea.trim()) return 'Describe the idea in a sentence or two.'
      if (guidedHasUi == null) return 'Pick whether the app has a UI.'
      return 'Ready to capture the idea.'
  }
}
