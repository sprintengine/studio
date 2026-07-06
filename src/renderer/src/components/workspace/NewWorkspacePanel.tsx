import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { userLayoutTemplateToTemplate } from '../../layouts/userTemplates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { CommentIcon, StandardWorkspaceTypeIcon } from '../AppIcons'
import { createMultiloopTemplate } from '../../modules/multiloop-workspace-types'
import { createGuidedBriefTemplate } from '../../modules/sprint-engine-workspace-types'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../../types/workspace'
import type {
  AgentCli,
  AgentId,
  DesignSystemSeedSource,
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
  SprintEngineRoleModelOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourceBundleKind,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineSavedRoster,
  SprintEngineRosterTeam,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
  Workspace,
  GuidedBriefRoleCliDefaults,
  GuidedBriefRoleModelOverrides,
  WorkspaceWindowId,
} from '../../types/workspace'
import { GuidedBriefFlow } from './guidedBrief/GuidedBriefFlow'
import { GuidedBriefCloseConfirmation } from './guidedBrief/GuidedBriefCloseConfirmation'
import { isMidStageGuidedRuntime, type GuidedBriefPreset, type GuidedBriefRuntimeState } from './guidedBrief/types'
import type { DesignSystemBrandDemoResolveResult } from '../../../../shared/design-system/brand-demo'
import type { DesignSystemAttachSource } from '../../../../shared/design-system/attach'
import {
  DesignSystemAttachStep,
  writeDesignSystemKnowledgeNote,
} from './newWorkspace/DesignSystemAttachStep'
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
import MulticodeMark from '../brand/MulticodeMark'
import MulticodeWordmark from '../brand/MulticodeWordmark'
import { CreationBackdrop } from '../backdrops/CreationBackdrop'
import { CliModelPickerButton, CloseIconButton, Field, GhostButton, Select, TruncatedText, WizardProgress } from '../ui'
import {
  analyzeWorkspaceTargetPath,
  defaultWorkspaceFolderPath,
  resolveDefaultParentPath,
} from './newWorkspace/folderCreation'
import { ModeCard } from './newWorkspace/ModeCard'
import AgentComposer, {
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerProjectOption,
} from './agentComposer/AgentComposer'
import { RecentFolderRow, isSameFolder } from './newWorkspace/RecentFolderRow'
import { type SprintEngineCliOption } from './newWorkspace/SprintEngineRosterTable'
import { sprintEngineRosterHasPlanningRole, sprintEngineRosterRoleFloor } from '../../utils/sprintengineRoleOptions'
import { useFolderHints, useFolderScan } from './newWorkspace/useNewWorkspaceFolder'
import { useBacklogScan } from './newWorkspace/useBacklogScan'
import { BacklogRowContent } from '../backlog/BacklogRow'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import type { BacklogItem, BacklogScanResult } from '../../utils/backlog'
import { compareBacklogItems } from '../../utils/backlogTriage'
import { childrenOfEpic, epicSlug } from '../../utils/backlogEpics'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { basename, folderKey, planBasename, markdownTitle, toTitleName, inferSourcePlanKind, workspaceRelativePath } from './newWorkspace/helpers'
import type { CreationMode, ExistingTeam, GuidedBriefHasUi, ModeCardModel, SprintEnginePath } from './newWorkspace/types'
import { isAdvancedSetupStep, stepsForMode, type StepId } from './newWorkspace/creationStepFlows'
import { KnowledgeStep } from './newWorkspace/KnowledgeStep'
import { shouldShowKnowledgeStep } from './newWorkspace/knowledgeFolders'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import { folderHintAutoSelectMode } from './newWorkspace/folderHintMode'
import { CliPermissionPresetRow, PathRadio, RosterAndRunSettings } from './newWorkspace/WizardControls'
import { pruneSprintEngineRoleCliDefaults, pruneSprintEngineRoleModelOverrides, resolveInitialSprintEngineRoster, sprintEngineRosterMatchesTeam } from './newWorkspace/savedTeams'
import {
  resolveAvailableAgentCli,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
} from './newWorkspace/cliRuntimeOptions'
import {
  DesignSystemScaffoldError,
  GuidedBriefScaffoldError,
  GuidedBriefStartBuildError,
  MultiloopControllerError,
  SprintEngineNewTeamCreationError,
  SprintEnginePlanSourcedError,
  buildSprintEngineEffectiveSpawnAtStartRoles,
  buildSprintEngineExistingTeamCreation,
  buildAutomationsCreation,
  buildStandardCreation,
  buildSwitchboardCreation,
  runDesignSystemScaffold,
  runGuidedBriefScaffold,
  runGuidedBriefStartBuild,
  runMultiloopCreation,
  runSprintEngineNewTeamCreation,
  runSprintEnginePlanSourcedCreation,
} from './newWorkspace/controllers'
import {
  getSprintEngineAccessState,
  requireFreshSprintEngineAccess,
  type PremiumFeatureAccessState,
} from '../../utils/premiumAccess'

// 'standard' is shell-owned (never a registered workspace type), so the picker
// seeds it here and appends the registry-contributed types after it.
const STANDARD_MODE_MODEL: ModeCardModel = {
  id: 'standard',
  label: 'Standard',
  description: 'IDE layout with editor, terminals, and file explorer for direct work.',
  icon: StandardWorkspaceTypeIcon,
}

// 'chat' is a shell-owned pseudo-type, not a registered workspace type: selecting
// it embeds the existing AgentComposer as the chat config surface (see the mode
// step) and creates a solo-agent chat via the same path as today's New chat. It
// leads the picker so New Agent opens on the lightest choice.
const CHAT_MODE_MODEL: ModeCardModel = {
  id: 'chat',
  label: 'Chat',
  description: 'A single agent you chat with, scoped to this project.',
  icon: CommentIcon,
}

const STEP_HEADING: Record<StepId, { title: string; subtitle: string }> = {
  workspace: {
    title: 'Name your workspace',
    subtitle: 'Give it a name and pick the folder it lives in.',
  },
  mode: {
    title: 'What do you want to start?',
    subtitle: 'Pick a workspace type to get going.',
  },
  'mcp-servers': {
    title: 'Pick tool integrations',
    subtitle: 'Connect agent tools for this project. Optional — skip and add later from Settings.',
  },
  'skill-packs': {
    title: 'Pick skill packs',
    subtitle: 'Curated agent skills installed into this project on creation. Optional — skip and add later from Settings.',
  },
  knowledge: {
    title: 'Connect a knowledge graph',
    subtitle: 'Point new agents at a folder of project knowledge they should read. Optional — skip and set it later in Settings.',
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
    title: 'What should the team work on?',
    subtitle: 'Start fresh, pick something from your backlog, or reopen a team.',
  },
  'sprintengine-roster': {
    title: 'Your AI team',
    subtitle: 'A balanced team is ready to go. Adjust it below, or just continue.',
  },
  'guided-idea': {
    title: 'Tell us about your idea',
    subtitle: 'A sentence or two, in plain words. We’ll ask the rest.',
  },
}

const SOURCE_PLAN_KIND_LABELS: Record<SprintEngineSourcePlanKind, string> = {
  product_plan: 'Product plan',
  architect_plan: 'Implementation plan',
  epic: 'Epic',
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

// Default first-run team for a from-scratch Sprint Engine: a runnable
// plan -> build -> review loop, not just planners. A novice who lands on the
// roster step can press Continue and get a team that actually implements and
// reviews work. Saved teams override this; it only seeds when none exists.
const initialSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  ui_ux_reviewer: 0,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 0,
  performance: 0,
  production_readiness_reviewer: 0,
  cross_platform: 0,
  tester: 0,
  security: 0,
}

const initialSprintEngineRoleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
  architect: 'claude-code',
  product: 'claude-code',
  frontend: 'claude-code',
  ui_ux_reviewer: 'claude-code',
  developer: 'claude-code',
  code_reviewer: 'claude-code',
  nuclear_reviewer: 'claude-code',
  spec_reviewer: 'claude-code',
  performance: 'claude-code',
  production_readiness_reviewer: 'claude-code',
  cross_platform: 'claude-code',
  tester: 'claude-code',
  security: 'claude-code',
}

function cloneSprintEngineRoleCounts(roleCounts: SprintEngineRoleCounts): SprintEngineRoleCounts {
  return { ...roleCounts }
}

function sprintEngineRoleCliDefaultsFromSavedRoster(
  savedRoster: SprintEngineSavedRoster | null | undefined,
): Required<SprintEngineRoleCliDefaults> {
  return {
    ...initialSprintEngineRoleCliDefaults,
    ...(savedRoster?.roleCliDefaults ?? {}),
  }
}

// Clamp every role's CLI default to an installed agent CLI. The catalog passed
// in is already availability-filtered, so resolveAvailableAgentCli remaps any
// role still pointing at an uninstalled CLI (e.g. a saved team's Claude Code on
// a Codex-only machine) to an installed one. Returns the same object reference
// when nothing changes so it is a no-op inside setState (no render thrash).
function remapRoleCliDefaultsToAvailable<T extends Record<string, AgentCli | undefined>>(
  defaults: T,
  catalog: AgentCliCatalogOption[],
): T {
  if (catalog.length === 0) return defaults
  let changed = false
  const next = { ...defaults }
  for (const role of Object.keys(defaults) as Array<keyof T>) {
    const current = defaults[role]
    if (current === undefined) continue
    const resolved = resolveAvailableAgentCli(current, catalog, current) as T[keyof T]
    if (resolved !== current) {
      next[role] = resolved
      changed = true
    }
  }
  return changed ? next : defaults
}

const guidedBriefSprintEngineRoleCounts: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 1,
  ui_ux_reviewer: 0,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 1,
  performance: 0,
  production_readiness_reviewer: 0,
  cross_platform: 0,
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
  product: initialSprintEngineRoleCliDefaults.product ?? 'claude-code',
  architect: initialSprintEngineRoleCliDefaults.architect ?? 'claude-code',
  frontend: initialSprintEngineRoleCliDefaults.frontend ?? 'claude-code',
}

export type NewWorkspacePanelInitialState = {
  mode?: CreationMode
  folderPath?: string | null
  futurePlanSource?: FuturePlanWorkspaceSource | null
}

// Host wiring for the embedded Chat composer (the 'chat' pseudo-type). The panel
// owns the folder (chosen on the workspace step) and feeds it to the composer; the
// host supplies the remembered agent, the shared spawn settings, the open-project
// options, and the confirm that maps to the existing solo-chat create path. Folder
// is threaded to onConfirm so the host spawns in the panel's chosen folder.
export type NewWorkspaceChatComposer = {
  projectOptions: ComposerProjectOption[]
  initialSelection: AgentComposerSelection
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  onConfirm: (confirm: AgentComposerConfirm, folderPath: string | null) => void
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
    guidedBriefState?: GuidedBriefRuntimeState | null
    mode?: WorkspaceMode
  }) => void
  onClose: () => void
  workspaceWindowId: WorkspaceWindowId
  allowClose?: boolean
  initialState?: NewWorkspacePanelInitialState | null
  chatComposer: NewWorkspaceChatComposer
}

export default function NewWorkspacePanel({
  onCreate,
  onClose,
  workspaceWindowId,
  allowClose = true,
  initialState = null,
  chatComposer,
}: Props) {
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const storedRecentFolders = useWorkspaceStore(
    (s) => s.appSettings.recentWorkspaceFolders ?? [],
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const setProjectKnowledgeRoot = useWorkspaceStore((s) => s.setProjectKnowledgeRoot)
  const lastSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? 'default',
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset,
  )
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  const saveSprintEngineRosterTeam = useWorkspaceStore((s) => s.saveSprintEngineRosterTeam)
  const renameSprintEngineRosterTeam = useWorkspaceStore((s) => s.renameSprintEngineRosterTeam)
  const deleteSprintEngineRosterTeam = useWorkspaceStore((s) => s.deleteSprintEngineRosterTeam)
  const setSprintEngineLastSelectedTeam = useWorkspaceStore((s) => s.setSprintEngineLastSelectedTeam)
  const sprintEngineTeams = sprintEngineRoleSettings.savedTeams ?? []
  const savedSprintEngineRoster = sprintEngineRoleSettings.savedRoster ?? null
  // Seed the wizard from the most recently selected team when one exists, else
  // the legacy single saved roster, else the built-in default — so the roster
  // step opens pre-selected on a runnable team and is a single Continue.
  const initialSprintEngineRoster = resolveInitialSprintEngineRoster({
    savedTeams: sprintEngineTeams,
    lastSelectedTeamId: sprintEngineRoleSettings.lastSelectedTeamId,
    savedRoster: savedSprintEngineRoster,
    defaultRoleCounts: initialSprintEngineRoleCounts,
    defaultRoleCliDefaults: initialSprintEngineRoleCliDefaults,
  })

  const initialFuturePlan = initialState?.futurePlanSource ?? null
  const initialMode: CreationMode =
    initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard')
  const initialFolderPath = initialState?.folderPath ?? initialFuturePlan?.folderPath ?? null
  const initialWorkspaceName =
    initialFuturePlan ? '' : initialFolderPath ? basename(initialFolderPath) || 'workspace' : ''

  const [mode, setMode] = useState<CreationMode>(initialMode)
  const [folderPath, setFolderPath] = useState<string | null>(initialFolderPath)
  // Unified folder field: a single editable full path that is created on
  // continue if it doesn't exist, or opened if it does. `folderPathPinned`
  // freezes name→path derivation once the user edits the path or browses.
  const [folderDraftPath, setFolderDraftPath] = useState<string>(initialFolderPath ?? '')
  const [folderPathPinned, setFolderPathPinned] = useState<boolean>(Boolean(initialFolderPath))
  const [folderDraftExists, setFolderDraftExists] = useState<boolean | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  // Whether the knowledge step applies to the chosen folder, snapshotted when the
  // folder is selected. Reading it live would let setting a knowledge folder (which
  // configures the project) drop the step out from under the user mid-step.
  const [knowledgeStepEligible, setKnowledgeStepEligible] = useState<boolean>(
    () => shouldShowKnowledgeStep(initialFolderPath, projectKnowledgeRoots),
  )
  const [name, setName] = useState(initialWorkspaceName)
  const [nameTouched, setNameTouched] = useState(false)
  const [layoutId, setLayoutId] = useState<string>(
    LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id,
  )
  const [userLayoutTemplates, setUserLayoutTemplates] = useState<LayoutTemplate[]>([])

  const loadUserLayoutTemplates = useCallback(async () => {
    if (typeof window.api.listUserLayoutTemplates !== 'function') return
    try {
      const result = await window.api.listUserLayoutTemplates()
      // Drop ids that collide with a bundled template: bundled wins in
      // buildStandardCreation, so a colliding user entry would be an
      // unselectable duplicate (and a duplicate React key) in the picker.
      const bundledIds = new Set(LAYOUT_TEMPLATES.map((template) => template.id))
      setUserLayoutTemplates(
        result.templates
          .filter((manifest) => !bundledIds.has(manifest.id))
          .map(userLayoutTemplateToTemplate)
      )
    } catch {
      // Best-effort; the bundled templates are always available.
    }
  }, [])

  useEffect(() => {
    void loadUserLayoutTemplates()
  }, [loadUserLayoutTemplates])

  const [sePath, setSePath] = useState<SprintEnginePath>(initialFuturePlan ? 'plan' : 'new')
  // Within the 'plan' source path: false = pick from the backlog list (default);
  // true = a hand-picked file outside the backlog. A pre-seeded future plan that
  // did not come from backlog/ opens straight into the file view.
  const [seSourceFromFile, setSeSourceFromFile] = useState<boolean>(
    Boolean(
      initialFuturePlan
      && !/^backlog\//i.test((initialFuturePlan.sourceRelativePath ?? '').replace(/\\/g, '/')),
    ),
  )
  const [sePlanPath, setSePlanPath] = useState(initialFuturePlan?.sourcePath ?? '')
  const [sePlanRelativePath, setSePlanRelativePath] = useState(initialFuturePlan?.sourceRelativePath ?? '')
  const [sePlanContent, setSePlanContent] = useState<string | null>(
    initialFuturePlan?.sourceContent ?? null,
  )
  const [seSourcePlanKind, setSeSourcePlanKind] = useState<SprintEngineSourcePlanKind>(
    initialFuturePlan?.sourcePlanKind ?? 'unknown',
  )
  const [seSourceBundle, setSeSourceBundle] = useState(initialFuturePlan?.sourceBundle ?? null)
  // Project-root-relative paths of an epic launch's child items, flipped to
  // in_progress at launch. Null for non-epic sources.
  const [seEpicChildRelativePaths, setSeEpicChildRelativePaths] = useState<string[] | null>(null)
  const [seExistingTeam, setSeExistingTeam] = useState<ExistingTeam | null>(null)
  const [seTeamName, setSeTeamName] = useState(initialFuturePlan?.teamName ?? '')
  const [seTeamNameTouched, setSeTeamNameTouched] = useState(Boolean(initialFuturePlan))
  const [seGoal, setSeGoal] = useState(initialFuturePlan?.goal ?? '')
  const [seRoleCounts, setSeRoleCounts] = useState<SprintEngineRoleCounts>(
    () => cloneSprintEngineRoleCounts(initialSprintEngineRoster.roleCounts),
  )
  const [seRoleCliDefaults, setSeRoleCliDefaults] = useState<Required<SprintEngineRoleCliDefaults>>(
    () => ({ ...initialSprintEngineRoster.roleCliDefaults }),
  )
  // Which saved team is currently loaded; null means a hand-tuned ("Custom") roster.
  const [seSelectedTeamId, setSeSelectedTeamId] = useState<string | null>(
    () => initialSprintEngineRoster.selectedTeamId,
  )
  const [seAgentCliOverrides, setSeAgentCliOverrides] = useState<Record<AgentId, AgentCli>>({})
  // Explicit per-role launch model (string = explicit id, null = explicit CLI
  // default/no model flag). Seeded from the initially selected saved team so the
  // roster opens on the model the team was saved with, not a blank override.
  const [seRoleModelOverrides, setSeRoleModelOverrides] = useState<SprintEngineRoleModelOverrides>(
    () => ({ ...initialSprintEngineRoster.roleModelOverrides }),
  )
  const [seRoleRegistry, setSeRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
  const [seRoleRegistryStatus, setSeRoleRegistryStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const [seStartRunner, setSeStartRunner] = useState(false)
  const [seUseWorktrees, setSeUseWorktrees] = useState(false)
  // Workspace-level concurrent-session cap (MC-1450: replaces the roster-size
  // ceiling). Clamped 1-10 at the input and again by the controller.
  const [seMaxParallelAgents, setSeMaxParallelAgents] = useState(3)
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
  const [guidedPreset, setGuidedPreset] = useState<GuidedBriefPreset>('full-brief')
  const [guidedHasUi, setGuidedHasUi] = useState<GuidedBriefHasUi | null>(null)
  const [guidedWantsProduct, setGuidedWantsProduct] = useState(true)
  const [guidedWantsArchitecture, setGuidedWantsArchitecture] = useState(false)
  const [guidedWantsFrontend, setGuidedWantsFrontend] = useState(true)
  const [guidedRoleCliDefaults, setGuidedRoleCliDefaults] = useState<GuidedBriefRoleCliDefaults>(
    initialGuidedBriefRoleCliDefaults,
  )
  // Explicit per-guided-role launch model (string = explicit id, null = explicit
  // CLI default/no model flag). Mirrors seRoleModelOverrides for the roster.
  const [guidedRoleModelOverrides, setGuidedRoleModelOverrides] = useState<GuidedBriefRoleModelOverrides>({})
  const [guidedError, setGuidedError] = useState<string | null>(null)
  const [guidedRuntimeState, setGuidedRuntimeState] = useState<GuidedBriefRuntimeState | null>(null)
  const [viewingIdeaAfterCommit, setViewingIdeaAfterCommit] = useState(false)
  const [closeConfirmation, setCloseConfirmation] = useState(false)
  // Design-system preset starting point: blank scaffold, seed from a
  // user-picked product folder, or seed from the built-in brand demo.
  const [guidedSeedMode, setGuidedSeedMode] = useState<DesignSystemSeedMode>('blank')
  const [guidedSeedFolderPath, setGuidedSeedFolderPath] = useState<string | null>(null)
  // null = not resolved yet; the demo card is disabled (with the cause as its
  // body copy) when the running build does not carry the demo source.
  const [guidedBrandDemo, setGuidedBrandDemo] = useState<DesignSystemBrandDemoResolveResult | null>(
    null,
  )

  // Design system to attach at create time (Advanced setup section). Null is
  // "none"; the attach IPC runs in the create-time preflight alongside the
  // other Advanced setup selections. Eligible for the three build entry
  // points only — never for the design-system authoring preset, which owns
  // design-system/ as its work product.
  const [dsAttachSelection, setDsAttachSelection] = useState<DesignSystemAttachSource | null>(null)

  // The selection is made against a concrete target folder; switching folders
  // invalidates it (folder B may already carry design-system/, which attach
  // refuses). Reset on folder change so a stale pick can never ride into
  // create — the Advanced setup count drops with it.
  useEffect(() => {
    setDsAttachSelection(null)
  }, [folderPath])

  // Resolve the brand-demo source lazily, the first time the design-system
  // preset is selected, so the other presets never pay the IPC.
  useEffect(() => {
    if (guidedPreset !== 'design-system' || guidedBrandDemo != null) return
    let cancelled = false
    window.api
      .resolveDesignSystemBrandDemoSeed()
      .then((result) => {
        if (!cancelled) setGuidedBrandDemo(result)
      })
      .catch(() => {
        if (!cancelled) {
          setGuidedBrandDemo({ ok: false, message: 'The built-in brand demo source could not be resolved.' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [guidedPreset, guidedBrandDemo])

  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  // Shared plugin-aware catalog (installed agents + configured runtimes) used by
  // both the Sprint Engine roster role pickers and the Guided Brief role pickers,
  // so opencode/custom agents are selectable everywhere new agents are configured.
  // Filtered by detected availability so uninstalled agent CLIs are never offered
  // or defaulted to (a Codex-only machine must not see/seed Claude Code).
  const sprintEngineCliOptions = useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, appCliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [pluginCatalogStatus, pluginCatalogEntries, appCliRuntimes, cliAvailability, cliAvailabilityStatus],
  )
  // Once detection is trustworthy, remap any role default seeded to an
  // uninstalled CLI (e.g. the Claude Code seed, or a saved team's Claude Code on
  // a Codex-only machine) to an installed agent so creation never deploys — or
  // even offers as the selected value — a CLI the user does not have. No-op when
  // the values are already installed (setState bails on the same reference).
  // Depends on the current defaults too so loading a saved team (which sets new
  // defaults without changing availability) is re-clamped. The remap is
  // idempotent — it returns the same object reference when nothing needs
  // changing, so setState bails and this converges without looping.
  useEffect(() => {
    if (cliAvailabilityStatus !== 'ready') return
    setSeRoleCliDefaults((current) => remapRoleCliDefaultsToAvailable(current, sprintEngineCliOptions))
    setGuidedRoleCliDefaults((current) => remapRoleCliDefaultsToAvailable(current, sprintEngineCliOptions))
  }, [cliAvailabilityStatus, sprintEngineCliOptions, seRoleCliDefaults, guidedRoleCliDefaults])
  const sprintEngineModuleEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'sprint-engine'))
  const multiloopModuleEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'multiloop'))
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
  const upsertSkillPack = useWorkspaceStore((s) => s.upsertSkillPack)
  const [integrationsMcpCatalog, setIntegrationsMcpCatalog] = useState<McpCatalogServer[]>([])
  const [integrationsSkillPackCatalog, setIntegrationsSkillPackCatalog] = useState<SkillPackCatalogEntry[]>([])
  const [integrationsMessage] = useState<string | null>(null)
  const [selectedSkillPackIds, setSelectedSkillPackIds] = useState<Set<string>>(new Set())
  // Surfaced when create-time Advanced setup persistence (MCP sync / skill-pack
  // install) fails, so the wizard reports the failure instead of closing as success.
  const [advancedSetupError, setAdvancedSetupError] = useState<string | null>(null)

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

  // Attach is offered on the three build entry points (standard, Sprint
  // Engine, Design Wizard) — never on the design-system authoring preset,
  // which owns design-system/ as its work product, and never on the
  // zero-config flows that skip Advanced setup.
  const designSystemAttachEligible =
    mode === 'standard'
    || mode === 'sprintengine'
    || (mode === 'guided-brief' && guidedPreset !== 'design-system')

  // Knowledge folder currently stored for the chosen project (case-preserved
  // key, matching the project-keyed store). Declared before
  // persistAdvancedSetup, which reads it for the attach step's bonus note.
  const committedKnowledgeRoot = useMemo(() => {
    const key = normalizeProjectRootKey(folderPath)
    return key ? projectKnowledgeRoots?.[key] ?? null : null
  }, [folderPath, projectKnowledgeRoots])

  // Persist the optional Advanced setup selections to the real project on disk:
  // write the MCP agent config through the same mcp:sync path Settings uses,
  // install each selected skill pack, then attach the selected design system
  // through the real attach IPC, awaiting every result so a failure surfaces
  // an actionable error instead of a silent fire-and-forget. Returns the failure
  // message (and sets advancedSetupError) when any selection failed, or null on
  // success, so callers avoid reporting a half-configured create as success.
  const persistAdvancedSetup = useCallback(
    async (workspaceRoot: string | null): Promise<string | null> => {
      if (!workspaceRoot) return null
      const failures: string[] = []

      const hasEnabledMcp = Boolean(
        mcpSettings && Object.values(mcpSettings.servers).some((server) => server.enabled),
      )
      if (hasEnabledMcp && mcpSettings && typeof window.api.mcpSync === 'function') {
        try {
          const result = await window.api.mcpSync({ workspaceRoot, settings: mcpSettings })
          if (!result.ok) {
            failures.push(`Tool integration setup failed: ${result.message}`)
          } else {
            const blocking = result.issues.find((issue) => issue.level === 'error')
            if (blocking) failures.push(`Tool integration setup failed: ${blocking.message}`)
          }
        } catch (error) {
          failures.push(`Tool integration setup failed: ${error instanceof Error ? error.message : 'sync error'}`)
        }
      }

      if (selectedSkillPackIds.size > 0 && typeof window.api.skillPackInstall === 'function') {
        const picks = integrationsSkillPackCatalog.filter((pack) => selectedSkillPackIds.has(pack.id))
        for (const pack of picks) {
          try {
            const result = await window.api.skillPackInstall({
              workspaceRoot,
              slug: pack.slug,
              harnesses: pack.harnesses,
              installedDirName: pack.installedDirName,
            })
            if (result.ok) {
              upsertSkillPack({
                ...result.installed,
                id: pack.id,
                name: pack.name,
                category: pack.category,
                description: pack.description,
                version: pack.version,
                sourceUrl: pack.sourceUrl,
                installedDirName: pack.installedDirName ?? result.installed.installedDirName,
              })
            } else {
              failures.push(`Skill pack ${pack.name} failed: ${result.message}`)
            }
          } catch (error) {
            failures.push(
              `Skill pack ${pack.name} failed: ${error instanceof Error ? error.message : 'install error'}`,
            )
          }
        }
      }

      // Attach the selected design system through the real T8 IPC. Fail
      // closed like the other setup steps: a refusal (conflict, invalid
      // bundle) aborts the create with the pipeline's own message — never a
      // silent half-attached workspace.
      if (dsAttachSelection && designSystemAttachEligible) {
        try {
          const result = await window.api.attachDesignSystemBundle(dsAttachSelection, workspaceRoot)
          if (!result.ok) {
            failures.push(`Design system attach failed: ${result.message}`)
          } else if (committedKnowledgeRoot) {
            // Bonus path when a knowledge root is configured: a pointer note
            // next to the graph (composed from the shared launch-line
            // contract). Non-fatal — the mechanism is KG-independent.
            try {
              await writeDesignSystemKnowledgeNote({
                workspaceRoot,
                knowledgeRoot: committedKnowledgeRoot,
                name: result.name,
                version: result.version,
              })
            } catch (error) {
              console.error('[design-system] could not write the knowledge-root pointer note', error)
            }
          }
        } catch (error) {
          failures.push(
            `Design system attach failed: ${error instanceof Error ? error.message : 'attach error'}`,
          )
        }
      }

      if (failures.length > 0) {
        const message = failures.join(' ')
        setAdvancedSetupError(message)
        return message
      }
      setAdvancedSetupError(null)
      return null
    },
    [
      mcpSettings,
      selectedSkillPackIds,
      integrationsSkillPackCatalog,
      upsertSkillPack,
      dsAttachSelection,
      designSystemAttachEligible,
      committedKnowledgeRoot,
    ],
  )

  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.authGetState()
      .then((state) => {
        if (!cancelled) setAuthState(state)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setAuthState])

  const isSprintEngine = mode === 'sprintengine'
  // 'chat' is the shell-owned pseudo-type: on the mode step it swaps the config
  // region for the embedded AgentComposer, which owns the chat's create action.
  const isChat = mode === 'chat'
  const folderScan = useFolderScan(folderPath)
  const backlogScan = useBacklogScan(isSprintEngine ? folderPath : null)
  const totalAgents = countSprintEngineAgents(visibleSprintEngineRoleCounts)

  const [step, setStep] = useState<StepId>(initialFuturePlan ? 'sprintengine-team' : 'workspace')
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward')

  const steps = useMemo(() => {
    const base = stepsForMode(mode)
    return knowledgeStepEligible ? base : base.filter((id) => id !== 'knowledge')
  }, [mode, knowledgeStepEligible])
  const stepIndex = Math.max(0, steps.indexOf(step))
  const isLastStep = stepIndex >= steps.length - 1
  // The optional Advanced setup disclosure rides the flow's final step but never
  // the 'mode' pivot (see isAdvancedSetupStep): the zero-config quick flows end
  // at 'mode', and config belongs off that decision screen.
  const showAdvancedSetup = isAdvancedSetupStep(steps, step)

  const handleCommitKnowledgeRoot = useCallback(
    (relativeRoot: string | null) => {
      if (folderPath) setProjectKnowledgeRoot(folderPath, relativeRoot)
    },
    [folderPath, setProjectKnowledgeRoot],
  )
  // Projects whose knowledge folder has been auto-applied, owned here so the value
  // survives the knowledge step unmounting as the wizard navigates.
  const knowledgeAutoAppliedRef = useRef<Set<string>>(new Set())

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

  // Cold-start fallback location for "Create new folder" when there's no
  // selected/recent folder to derive a parent from. Fetched once; the resolver
  // only uses it when nothing else is known.
  const [defaultFolderParent, setDefaultFolderParent] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void window.api.defaultWorkspaceParentDir?.()
      .then((dir) => {
        if (active) setDefaultFolderParent(dir)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Default parent for a brand-new workspace folder, used to derive the unified
  // field's proposed path while the user hasn't pinned one.
  const defaultDraftParent = useMemo(
    () => resolveDefaultParentPath({ folderPath: null, recentFolders, fallbackParent: defaultFolderParent }),
    [recentFolders, defaultFolderParent],
  )

  // While the path isn't pinned, keep it derived from the workspace name +
  // default location (e.g. ~/Documents/my-app), so the common "new folder named
  // after my workspace" case needs zero interaction.
  useEffect(() => {
    if (folderPathPinned) return
    const proposed = defaultWorkspaceFolderPath(defaultDraftParent, name)
    setFolderDraftPath(proposed ?? '')
  }, [folderPathPinned, defaultDraftParent, name])

  // The reverse direction: once the user pins a concrete folder (Recent row,
  // Browse, or a typed path), default the workspace name to that folder's
  // basename until they edit the name themselves — so choosing an existing
  // project never requires retyping its name. Only runs when pinned, so it can't
  // fight the name→path derivation above (which only runs when unpinned).
  useEffect(() => {
    if (!folderPathPinned || nameTouched) return
    const leaf = basename(folderDraftPath.trim())
    if (leaf) setName(leaf)
  }, [folderPathPinned, folderDraftPath, nameTouched])

  // Existence-aware status for the draft path (display only — folder creation
  // and detection happen on continue). Debounced so typing stays responsive.
  useEffect(() => {
    const target = folderDraftPath.trim()
    if (!target) {
      setFolderDraftExists(null)
      return
    }
    let active = true
    const id = window.setTimeout(() => {
      void window.api.pathExists(target)
        .then((exists) => {
          if (active) setFolderDraftExists(exists)
        })
        .catch(() => {
          if (active) setFolderDraftExists(null)
        })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(id)
    }
  }, [folderDraftPath])

  // Sync initial future-plan option into the scan list once available.
  useEffect(() => {
    if (!initialFuturePlan) return
    setSePath('plan')
    setSePlanPath(initialFuturePlan.sourcePath)
    setSePlanRelativePath(initialFuturePlan.sourceRelativePath)
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
    // The 'plan' (backlog) path stays selectable even with an empty backlog —
    // the step shows an empty state that offers a new team or a hand-picked file
    // rather than bouncing the user back to 'new'.
  }, [isSprintEngine, sePath, folderScan.result, folderScan.isScanning, sePlanPath])

  // When the step list changes (mode switch, or the knowledge step dropping out
  // for an already-configured folder), keep the current step valid.
  useEffect(() => {
    if (!steps.includes(step)) {
      const fallback = steps.includes('mode') ? 'mode' : steps[0]
      setStep(fallback as StepId)
    }
  }, [steps, step])

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

  // Ready when the workspace is named and the folder field resolves to a usable
  // target: an existing folder (opened as-is) or a structurally valid path we
  // can create. Creation/opening happens on continue (`materializeWorkspaceFolder`).
  const folderTargetUsable =
    folderDraftExists === true || analyzeWorkspaceTargetPath(folderDraftPath).ok
  const workspaceStepReady = folderTargetUsable && name.trim().length > 0
  const standardLayoutStepReady = Boolean(layoutId)
  const multiloopGoalReady = mlGoal.trim().length > 0
  const sePlanReady =
    sePath !== 'plan' || (sePlanPath !== '' && sePlanContent != null && !sePlanError)
  const seTeamDetailsReady =
    seExistingTeam != null
    || (sePath === 'plan'
      ? seTeamName.trim().length > 0
      : seTeamName.trim().length > 0 && seGoal.trim().length > 0)
  const sprintEngineTeamReady =
    sprintEngineAccess.allowed && sePlanReady && seTeamDetailsReady
  // A new roster needs at least one agent AND at least one planning-capable
  // agent (architect or general); existing teams were already validated when
  // created. The stepper floors prevent dropping the last planner interactively,
  // so this is the defensive gate for loaded/saved counts.
  const sprintEngineRosterReady =
    sprintEngineAccess.allowed
    && (seExistingTeam != null
      || (totalAgents > 0 && sprintEngineRosterHasPlanningRole(visibleSprintEngineRoleCounts)))
  // The resolved seed source for the design-system preset. Null means blank
  // start — either chosen deliberately, or because a seed mode is selected but
  // its source is not resolved yet (folder not picked / demo unavailable), in
  // which case `guidedSeedReady` blocks Continue instead of silently starting blank.
  const guidedSeedSource: DesignSystemSeedSource | null =
    guidedPreset === 'design-system' && guidedSeedMode === 'source-folder' && guidedSeedFolderPath
      ? { kind: 'source-folder', path: guidedSeedFolderPath }
      : guidedPreset === 'design-system' && guidedSeedMode === 'brand-demo' && guidedBrandDemo?.ok
        ? { kind: 'brand-demo', path: guidedBrandDemo.path }
        : null
  const guidedSeedReady =
    guidedPreset !== 'design-system' || guidedSeedMode === 'blank' || guidedSeedSource != null
  const guidedIdeaReady = guidedIdea.trim().length > 0 && guidedHasUi != null && guidedSeedReady

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
    workspaceFolderReady: folderTargetUsable,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seTeamDetailsReady,
    totalAgents,
    guidedIdea,
    guidedHasUi,
    guidedSeedMode,
    guidedSeedReady,
    committedKnowledgeRoot,
  })

  const handleSelectMode = (next: CreationMode) => {
    setMode(next)
    if (next === 'standard' && !nameTouched) setName(basename(folderPath ?? '') || 'workspace')
    if (next === 'switchboard' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Switchboard')
    if (next === 'multiloop')
      setMlName(toTitleName(basename(folderPath ?? '')) || 'Product Loop')
    if (next === 'guided-brief' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Design Wizard')
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

  // Folder-scoped source state is invalidated whenever the target folder changes:
  // a saved team, plan/bundle selection, or error message all belong to the old
  // folder. Shared by every folder-change path (workspace step + chat chip) so the
  // invariant holds no matter where the switch happens.
  const resetFolderScopedSourceState = () => {
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    setSePlanPath('')
    setSePlanRelativePath('')
    setSePlanContent(null)
    setSeSourcePlanKind('unknown')
    setSeSourceBundle(null)
    setSeEpicChildRelativePaths(null)
    setSeSourceFromFile(false)
    setSePlanError(null)
    setMlError(null)
  }

  const handleSelectFolder = (dir: string) => {
    const folderName = basename(dir)
    setFolderPath(dir)
    setKnowledgeStepEligible(shouldShowKnowledgeStep(dir, projectKnowledgeRoots))
    resetFolderScopedSourceState()
    if (!nameTouched) setName(folderName || 'workspace')
    if (!seTeamNameTouched) setSeTeamName(toTitleName(folderName) || 'Sprint Roster')
    setMlName(toTitleName(folderName) || 'Product Loop')

    // Don't auto-select a mode whose module the user disabled, and only seed a
    // mode when the user hasn't already named the workspace.
    const autoMode = folderHintAutoSelectMode(folderHints.get(dir), {
      sprintEngineEnabled: sprintEngineModuleEnabled,
      multiloopEnabled: multiloopModuleEnabled,
    })
    if (!nameTouched && autoMode) handleSelectMode(autoMode)
  }

  // Unified folder field edits. Editing or browsing pins the path so the
  // name→path derivation stops overriding the user's choice.
  const handleChangeFolderDraftPath = (value: string) => {
    setFolderPathPinned(true)
    setFolderDraftPath(value)
    setFolderError(null)
  }

  const pickFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setFolderPathPinned(true)
    setFolderDraftPath(dir)
    setFolderError(null)
  }

  const handleSelectRecentFolder = (dir: string) => {
    setFolderPathPinned(true)
    setFolderDraftPath(dir)
    setFolderError(null)
  }

  // The embedded Chat composer's project chip retargets the panel's already-
  // materialized folder (chosen on the workspace step). It edits the same folder
  // state Back would show, so switching project here and stepping back stay in
  // sync; the folder is passed straight to the solo-chat create on confirm.
  const handleChatSelectProject = (path: string) => {
    setFolderPath(path)
    setFolderDraftPath(path)
    setFolderPathPinned(true)
    setKnowledgeStepEligible(shouldShowKnowledgeStep(path, projectKnowledgeRoots))
    // Keep the folder-change invariant even though chat never reads this state:
    // the user can switch to Sprint Engine after picking a project here.
    resetFolderScopedSourceState()
  }
  const handleChatBrowseProject = async () => {
    const dir = await window.api.openDir()
    if (dir) handleChatSelectProject(dir)
  }

  // Materialize the unified folder field into a concrete folder before leaving
  // the workspace step: create it if missing, open it if it exists, then run the
  // existing detection (`handleSelectFolder`) so `folderPath` is concrete for
  // every downstream step. Returns false (and surfaces an error) on failure.
  const materializeWorkspaceFolder = async (): Promise<boolean> => {
    const target = folderDraftPath.trim()
    if (!target) {
      setFolderError('Choose a folder for the workspace.')
      return false
    }
    let exists = false
    try {
      exists = await window.api.pathExists(target)
    } catch {
      exists = false
    }
    if (exists) {
      handleSelectFolder(target)
      return true
    }
    const analysis = analyzeWorkspaceTargetPath(target)
    if (!analysis.ok) {
      setFolderError(analysis.error)
      return false
    }
    try {
      const created = await window.api.createWorkspaceFolder(analysis.parent, analysis.leaf)
      handleSelectFolder(created)
      return true
    } catch (caught) {
      setFolderError(caught instanceof Error ? caught.message : 'Could not create that folder.')
      return false
    }
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
    // A canonical team's roster comes from projection state, not a saved preset;
    // detach the preset picker so its Update/Delete affordances aren't stale.
    setSeSelectedTeamId(null)
    setSeTeamName(team.displayName)
    setSeGoal(team.state.goal)
    setSeRoleCounts(team.state.roleCounts)
    if (savedSprintEngineRoster) {
      setSeRoleCliDefaults({
        ...cliSelection.roleDefaults,
        ...savedSprintEngineRoster.roleCliDefaults,
      })
      setSeAgentCliOverrides({})
    } else {
      setSeRoleCliDefaults(cliSelection.roleDefaults)
      setSeAgentCliOverrides(cliSelection.agentOverrides)
    }
  }

  // Shared application of a chosen source (backlog item or hand-picked file)
  // into the plan-sourced creation state. Backlog items pass their already
  // derived title and loaded content; the file picker passes freshly read
  // content. `fromFile` switches the step between the backlog list and the
  // hand-picked-file view.
  const applyPlanSource = (input: {
    path: string
    relativePath: string
    content: string
    title?: string
    fromFile: boolean
    // When the selected item is an epic, its child design documents. The epic
    // becomes the root (`epic`) plan source and the children become the source
    // bundle; each is referenced in place, never copied.
    epicChildren?: BacklogItem[]
  }) => {
    const fallbackName = planBasename(input.relativePath)
    const goal = input.title?.trim() || markdownTitle(input.content) || toTitleName(fallbackName)
    const isHtmlSource = /\.html?$/i.test(input.relativePath)
    const epicChildren = input.epicChildren ?? []
    const isEpicSource = epicChildren.length > 0
    setSePlanPath(input.path)
    setSePlanRelativePath(input.relativePath)
    setSePlanContent(input.content)
    setSePlanError(null)
    if (isEpicSource) {
      setSeSourcePlanKind('epic')
      setSeSourceBundle(epicChildren.map((child) => {
        const inferred = inferSourcePlanKind(child.relativePath, child.sourceContent)
        return {
          kind: /\.html?$/i.test(child.relativePath)
            ? 'html_mockup'
            : inferred === 'product_plan' || inferred === 'architect_plan'
              ? inferred
              : 'generic_context',
          sourcePath: child.path,
          sourceRelativePath: child.relativePath,
          sourceContent: child.sourceContent,
        }
      }))
      setSeEpicChildRelativePaths(epicChildren.map((child) => child.relativePath))
    } else {
      setSeSourcePlanKind(isHtmlSource ? 'unknown' : inferSourcePlanKind(input.relativePath, input.content))
      setSeSourceBundle(isHtmlSource
        ? [{
          kind: 'html_mockup',
          sourcePath: input.path,
          sourceRelativePath: input.relativePath,
          sourceContent: input.content,
        }]
        : null)
      setSeEpicChildRelativePaths(null)
    }
    if (!seTeamNameTouched) setSeTeamName(slugifySprintEngineName(fallbackName))
    setSeGoal(goal)
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    setSeSourceFromFile(input.fromFile)
  }

  const handleSelectBacklogItem = (item: BacklogItem) => {
    // An epic launch plans the whole epic: hand the architect the epic plus every
    // child design document (referenced in place). Non-epic items launch as a
    // single reference source.
    const epicChildren = item.isEpic
      ? childrenOfEpic(backlogScan.result.items, epicSlug(item)).filter((child) => child.status !== 'archived')
      : []
    applyPlanSource({
      path: item.path,
      relativePath: item.relativePath,
      content: item.sourceContent,
      title: item.title,
      fromFile: false,
      epicChildren,
    })
  }

  const handlePickSourceFile = async () => {
    if (!folderPath) return
    const picked = await window.api.openFile({
      title: 'Choose a source file',
      defaultPath: folderPath,
      filters: [{ name: 'Plans & mockups', extensions: ['md', 'markdown', 'html', 'htm'] }],
    })
    if (!picked) return
    try {
      const content = await window.api.readfile(picked)
      const relativePath = workspaceRelativePath(folderPath, picked) ?? planBasename(picked)
      applyPlanSource({ path: picked, relativePath, content, fromFile: true })
    } catch {
      setSePlanError('Could not read the selected file.')
    }
  }

  // Return from the hand-picked-file view to the backlog list, dropping the
  // file selection so the step doesn't carry a stale source into creation.
  const handleBackToBacklog = () => {
    setSeSourceFromFile(false)
    setSePlanPath('')
    setSePlanRelativePath('')
    setSePlanContent(null)
    setSeSourcePlanKind('unknown')
    setSeSourceBundle(null)
    setSeEpicChildRelativePaths(null)
    setSePlanError(null)
  }

  const setRoleCount = (role: SprintEngineRoleId, count: number) => {
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    setSeRoleCliDefaults((current) => ({
      ...current,
      // Seed a newly surfaced role with an installed CLI rather than the raw
      // Claude Code default, so bumping a role count never reintroduces an
      // uninstalled agent on a machine that lacks it.
      [role]: current[role] ?? resolveAvailableAgentCli('claude-code', sprintEngineCliOptions, 'claude-code'),
    }))
    setSeRoleCounts((current) => {
      // Floor against the current counts so a planning role (architect/general)
      // can only drop to 0 while the other planner is staffed — the roster
      // never loses its last planning-capable agent. Counts are an enabled-set
      // encoding (MC-1450): every role is 0 or 1; parallelism comes from the
      // max-parallel-agents knob + mint-on-demand, not headcounts.
      const min = sprintEngineRosterRoleFloor(role, current)
      return {
        ...current,
        [role]: Math.max(min, Math.min(1, Math.floor(count))),
      }
    })
  }

  const setRoleCli = (role: SprintEngineRoleId, cli: AgentCli) => {
    setSeRoleCliDefaults((current) => ({ ...current, [role]: cli }))
    // A model picked for the previous CLI is meaningless on the new one;
    // drop the override so the row falls back to the new CLI's remembered
    // model default.
    setSeRoleModelOverrides((current) => {
      if (!(role in current)) return current
      const next = { ...current }
      delete next[role]
      return next
    })
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

  const setGuidedRoleModel = (role: keyof GuidedBriefRoleCliDefaults, model: string | null) => {
    setGuidedRoleModelOverrides((current) => ({ ...current, [role]: model }))
  }

  const setRoleModel = (role: SprintEngineRoleId, model: string | null) => {
    setSeRoleModelOverrides((current) => ({ ...current, [role]: model }))
  }

  // Lazy roster: only the architect carries a start-at-launch intent (no
  // per-role "Start now" toggle). Worker/reviewer ids are minted on demand.
  const seInitialSpawnRoles = useMemo(
    () => (Object.entries(buildSprintEngineEffectiveSpawnAtStartRoles({
      automationMode: seAutomationMode,
      existingTeam: seExistingTeam != null,
      visibleRoleCounts: visibleSprintEngineRoleCounts,
    })) as Array<[SprintEngineRoleId, boolean | undefined]>)
      .filter(([, spawn]) => spawn)
      .map(([role]) => role),
    [seAutomationMode, seExistingTeam, visibleSprintEngineRoleCounts],
  )

  const handleChooseGuidedSeedFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setGuidedSeedFolderPath(dir)
    setGuidedSeedMode('source-folder')
    setGuidedError(null)
  }

  // The design-only presets (Design only, Design system) force the studio
  // path: a screen is implied, the product and architecture discussions are
  // off, and the frontend discussion is on. Switching back to the full brief
  // restores the standard defaults and re-asks the has-UI question.
  const handleChangeGuidedPreset = (next: GuidedBriefPreset) => {
    setGuidedPreset(next)
    setGuidedError(null)
    if (next === 'frontend-design' || next === 'design-system') {
      setGuidedHasUi('yes')
      setGuidedWantsProduct(false)
      setGuidedWantsArchitecture(false)
      setGuidedWantsFrontend(true)
    } else {
      setGuidedWantsProduct(true)
      setGuidedWantsArchitecture(false)
      setGuidedWantsFrontend(guidedHasUi !== 'no')
    }
  }

  const sprintEngineConfig = useMemo<SprintEngineMockConfig>(
    () => ({
      name: seTeamName.trim() || 'Sprint Roster',
      goal: seGoal.trim(),
      roleCounts: visibleSprintEngineRoleCounts,
    }),
    [seGoal, visibleSprintEngineRoleCounts, seTeamName],
  )

  const persistLastPermissionPreset = () => {
    setLastAgentSpawnPermissionPreset(cliPermissionPreset)
  }

  // Load a saved team into the wizard rows, or detach to a custom roster when
  // id is null. Mirrors setRoleCount's resets so a freshly loaded team starts clean.
  const handleSelectSprintEngineTeam = (id: string | null) => {
    if (!id) {
      setSeSelectedTeamId(null)
      setSprintEngineLastSelectedTeam(null)
      return
    }
    const team = sprintEngineTeams.find((entry) => entry.id === id)
    if (!team) return
    setSeExistingTeam(null)
    setSeAgentCliOverrides({})
    // Restore the team's saved per-role model overrides (absent = CLI default).
    setSeRoleModelOverrides({ ...(team.roleModelOverrides ?? {}) })
    setSeRoleCounts(cloneSprintEngineRoleCounts(team.roleCounts))
    setSeRoleCliDefaults(sprintEngineRoleCliDefaultsFromSavedRoster(team))
    setSeSelectedTeamId(team.id)
    setSprintEngineLastSelectedTeam(team.id)
  }

  const handleSaveSprintEngineTeam = (name: string) => {
    const id = saveSprintEngineRosterTeam({
      name,
      roleCounts: cloneSprintEngineRoleCounts(visibleSprintEngineRoleCounts),
      roleCliDefaults: pruneSprintEngineRoleCliDefaults(visibleSprintEngineRoleCounts, seRoleCliDefaults),
      roleModelOverrides: pruneSprintEngineRoleModelOverrides(visibleSprintEngineRoleCounts, seRoleModelOverrides),
    })
    if (id) setSeSelectedTeamId(id)
  }

  // "Update" re-saves the current (edited) roster under the team's existing name.
  const handleUpdateSprintEngineTeam = (id: string, name: string) => {
    saveSprintEngineRosterTeam({
      id,
      name,
      roleCounts: cloneSprintEngineRoleCounts(visibleSprintEngineRoleCounts),
      roleCliDefaults: pruneSprintEngineRoleCliDefaults(visibleSprintEngineRoleCounts, seRoleCliDefaults),
      roleModelOverrides: pruneSprintEngineRoleModelOverrides(visibleSprintEngineRoleCounts, seRoleModelOverrides),
    })
    setSeSelectedTeamId(id)
  }

  // "Rename" changes only the name, leaving the saved roster intact — so renaming
  // never silently overwrites a team with the current (possibly edited) rows.
  const handleRenameSprintEngineTeam = (id: string, name: string) => {
    renameSprintEngineRosterTeam(id, name)
    setSeSelectedTeamId(id)
  }

  const handleDeleteSprintEngineTeam = (id: string) => {
    deleteSprintEngineRosterTeam(id)
    if (seSelectedTeamId === id) setSeSelectedTeamId(null)
  }

  // The saved team the roster was loaded from, and whether the current rows still
  // match it. Drives the picker's truthful "edited" state (the rows no longer
  // equal the named team) and gates the Update affordance.
  const selectedSprintEngineTeam = useMemo(
    () => (seSelectedTeamId ? sprintEngineTeams.find((team) => team.id === seSelectedTeamId) ?? null : null),
    [seSelectedTeamId, sprintEngineTeams],
  )
  const selectedSprintEngineTeamDirty = useMemo(
    () => (selectedSprintEngineTeam
      ? !sprintEngineRosterMatchesTeam(
          selectedSprintEngineTeam,
          visibleSprintEngineRoleCounts,
          seRoleCliDefaults,
          seRoleModelOverrides,
        )
      : false),
    [selectedSprintEngineTeam, visibleSprintEngineRoleCounts, seRoleCliDefaults, seRoleModelOverrides],
  )

  const handleCreate = async () => {
    // 'chat' has no wizard create path: it is created by the embedded composer's
    // own confirmation path (host solo-chat create). Guard so an Enter that reaches the
    // section handler on the chat mode step can never fall through to Standard.
    if (isChat) return
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
        if (await persistAdvancedSetup(folderPath)) return
        const guidedFilesystem = {
          ensureDir: window.api.ensureDir,
          readFile: window.api.readfile,
          writeFile: window.api.writefile,
        }
        const buildRoleCounts = applyUserDisabledSprintEngineRoleCounts(
          guidedBriefBuildRoleCountsForSurface(guidedHasUi),
          sprintEngineDisabledRoleIds,
        )
        const { runtimeState } = guidedPreset === 'design-system'
          ? await runDesignSystemScaffold(
              {
                folderPath,
                workspaceName: name,
                idea: guidedIdea,
                seedSource: guidedSeedSource,
                guidedRoleCliDefaults,
                guidedRoleModelOverrides,
                buildRoleCounts,
                buildRoleCliDefaults: seRoleCliDefaults,
                buildCliPermissionPreset: cliPermissionPreset,
                buildStartRunner: seStartRunner,
                buildAutoApproveArtifacts: seAutoApproveArtifacts,
              },
              {
                filesystem: guidedFilesystem,
                scaffoldBundle: window.api.scaffoldDesignSystemBundle,
              },
            )
          : await runGuidedBriefScaffold(
              {
                folderPath,
                workspaceName: name,
                idea: guidedIdea,
                hasUi: guidedHasUi,
                preset: guidedPreset,
                wantsProduct: guidedWantsProduct,
                wantsArchitecture: guidedWantsArchitecture,
                wantsFrontend: guidedWantsFrontend,
                guidedRoleCliDefaults,
                guidedRoleModelOverrides,
                buildRoleCounts,
                buildRoleCliDefaults: seRoleCliDefaults,
                buildCliPermissionPreset: cliPermissionPreset,
                buildStartRunner: seStartRunner,
                buildAutoApproveArtifacts: seAutoApproveArtifacts,
              },
              {
                filesystem: guidedFilesystem,
              },
            )
        onCreate({
          template: createGuidedBriefTemplate(),
          name: runtimeState.workspaceName,
          folderPath,
          mode: 'guided-brief',
          guidedBriefState: runtimeState,
        })
      } catch (error) {
        setGuidedError(
          (error instanceof GuidedBriefScaffoldError || error instanceof DesignSystemScaffoldError)
            && error.message !== error.code
            ? error.message
            : error instanceof GuidedBriefScaffoldError || error instanceof DesignSystemScaffoldError
              ? `Could not set up the Design Wizard workspace (${error.code}).`
              : error instanceof Error
                ? error.message
                : 'Could not set up the Design Wizard workspace.',
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
        if (await persistAdvancedSetup(folderPath)) return
        await runMultiloopCreation(
          {
            folderPath,
            workspaceName: name,
            loopName: mlName,
            finalGoal: mlGoal,
            cliPermissionPreset,
            workspaceWindowId,
          },
          {
            initializeMultiloopState: window.api.initializeMultiloopState,
            readFile: window.api.readfile,
            addWorkspace,
            createMultiloopTemplate,
          },
        )
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
      setIsCreating(true)
      try {
        if (await persistAdvancedSetup(folderPath)) return
        onCreate(buildSwitchboardCreation({ name, folderPath }))
        onClose()
      } finally {
        setIsCreating(false)
      }
      return
    }

    if (mode === AUTOMATIONS_HOST_WORKSPACE_MODE) {
      if (!folderPath) return
      setIsCreating(true)
      try {
        if (await persistAdvancedSetup(folderPath)) return
        onCreate(buildAutomationsCreation({ name, folderPath }))
        onClose()
      } finally {
        setIsCreating(false)
      }
      return
    }

    if (mode === 'sprintengine') {
      try {
        await requireFreshSprintEngineAccess(window.api, setAuthState)
      } catch (error) {
        setSePlanError(error instanceof Error ? error.message : 'Sprint access could not be verified.')
        return
      }

      if (seExistingTeam) {
        const args = buildSprintEngineExistingTeamCreation({
          folderPath,
          existingTeam: seExistingTeam,
          roleCliDefaults: seRoleCliDefaults,
          agentCliOverrides: seAgentCliOverrides,
          roleModelOverrides: seRoleModelOverrides,
          initialSpawnRoles: seInitialSpawnRoles,
          startRunner: seStartRunner,
          autoApproveArtifacts: seAutoApproveArtifacts,
          cliPermissionPreset,
        })
        setIsCreating(true)
        try {
          if (await persistAdvancedSetup(folderPath)) return
          onCreate(args)
          persistLastPermissionPreset()
        } finally {
          setIsCreating(false)
        }
        return
      }

      if (sePath === 'plan' && sePlanPath) {
        if (!folderPath) {
          setSePlanError('Pick a folder before creating from a plan.')
          return
        }
        // For an epic the epic file itself is the primary handover source and the
        // bundle holds its children; every other bundle uses its first item.
        const isEpicSource = seSourcePlanKind === 'epic'
        const bundlePrimary = !isEpicSource ? (seSourceBundle?.[0] ?? null) : null
        const option = bundlePrimary
          ? { path: bundlePrimary.sourcePath, relativePath: bundlePrimary.sourceRelativePath }
          : sePlanPath
            ? { path: sePlanPath, relativePath: sePlanRelativePath }
            : null
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
        setIsCreating(true)
        try {
          if (await persistAdvancedSetup(folderPath)) return
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
              maxParallelAgents: seMaxParallelAgents,
              roleCliDefaults: seRoleCliDefaults,
              roleModelOverrides: seRoleModelOverrides,
              initialSpawnRoles: seInitialSpawnRoles,
              startRunner: seStartRunner,
              autoApproveArtifacts: seAutoApproveArtifacts,
              useWorktrees: seUseWorktrees,
              // Backlog/file sources are referenced in place, never copied.
              sourceReference: true,
              epicChildRelativePaths: seEpicChildRelativePaths ?? undefined,
              cliPermissionPreset,
              workspaceWindowId,
            },
            {
              pathExists: window.api.pathExists,
              initializeSprintEngineState: window.api.initializeSprintEngineState,
              recordBacklogExecutionLink: async ({ workspaceRoot, sourceRelativePath, teamSlug, statePath, childRelativePaths }) => {
                const result = await window.api.addOrUpdateBacklogLink({
                  workspaceRoot,
                  relativePath: sourceRelativePath,
                  link: {
                    id: `sprint-engine:${teamSlug}`,
                    moduleId: 'sprint-engine',
                    type: 'execution',
                    label: 'Sprint',
                    target: {
                      kind: 'sprintengine.run',
                      id: teamSlug,
                      path: workspaceRelativePath(workspaceRoot, statePath) ?? statePath,
                    },
                    status: 'active',
                  },
                  status: 'in_progress',
                })
                if (!result.ok) throw new Error(result.message)
                // Flip every epic child to in_progress in the main checkout so the
                // whole epic shows the sprint immediately. Never downgrade a child
                // that is already in_progress or completed.
                for (const childPath of childRelativePaths ?? []) {
                  const child = backlogScan.result.items.find((item) => item.relativePath === childPath)
                  if (child && (child.status === 'in_progress' || child.status === 'completed')) continue
                  const childResult = await window.api.updateBacklogStatus({
                    workspaceRoot,
                    relativePath: childPath,
                    status: 'in_progress',
                  })
                  if (!childResult.ok) throw new Error(childResult.message)
                }
              },
            },
          )
          persistLastPermissionPreset()
          onClose()
        } catch (error) {
          if (error instanceof SprintEnginePlanSourcedError) {
            setSePlanError(planSourcedErrorMessage(error))
          } else {
            setSePlanError(
              error instanceof Error ? error.message : 'Could not create the sprint workspace.',
            )
          }
        } finally {
          setIsCreating(false)
        }
        return
      }

      setIsCreating(true)
      try {
        if (await persistAdvancedSetup(folderPath)) return
        const args = await runSprintEngineNewTeamCreation(
          {
            folderPath,
            teamName: sprintEngineConfig.name,
            goal: sprintEngineConfig.goal,
            roleCounts: visibleSprintEngineRoleCounts,
            visibleRoleCounts: visibleSprintEngineRoleCounts,
            maxParallelAgents: seMaxParallelAgents,
            roleCliDefaults: seRoleCliDefaults,
            roleModelOverrides: seRoleModelOverrides,
            initialSpawnRoles: seInitialSpawnRoles,
            startRunner: seStartRunner,
            autoApproveArtifacts: seAutoApproveArtifacts,
            useWorktrees: seUseWorktrees,
            cliPermissionPreset,
          },
          {
            pathExists: window.api.pathExists,
            initializeSprintEngineState: window.api.initializeSprintEngineState,
          },
        )
        onCreate(args)
        persistLastPermissionPreset()
      } catch (error) {
        if (error instanceof SprintEngineNewTeamCreationError) {
          setSePlanError(newTeamCreationErrorMessage(error))
        } else {
          setSePlanError(
            error instanceof Error ? error.message : 'Could not create the sprint workspace.',
          )
        }
      } finally {
        setIsCreating(false)
      }
      return
    }

    // Standard
    const args = buildStandardCreation({ layoutId, name, folderPath, userTemplates: userLayoutTemplates })
    setIsCreating(true)
    try {
      if (await persistAdvancedSetup(folderPath)) return
      onCreate(args)
    } finally {
      setIsCreating(false)
    }
  }

  const goNext = () => {
    if (!canAdvanceFromCurrent || isCreating) return
    if (isLastStep) {
      void handleCreate()
      return
    }
    // Leaving the workspace step materializes the folder (create-if-missing /
    // open-if-exists) so `folderPath` is concrete before the mode step renders.
    if (step === 'workspace') {
      void (async () => {
        setIsCreating(true)
        try {
          if (!(await materializeWorkspaceFolder())) return
          setDirection('forward')
          setStep(steps[stepIndex + 1])
        } finally {
          setIsCreating(false)
        }
      })()
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

  // Back-jump from the progress bar: only to an already-completed (earlier) step,
  // and never mid-create. The step-change effect handles focus + scroll reset.
  const jumpToStep = (index: number) => {
    if (isCreating) return
    if (index < 0 || index >= stepIndex) return
    setDirection('backward')
    setStep(steps[index])
  }
  const stepLabels = useMemo(() => steps.map((id) => STEP_HEADING[id].title), [steps])

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
    const currentState = await window.api.authGetState().catch(() => null)
    if (currentState?.authenticated) {
      setAuthState(currentState)
      return
    }
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
    try {
      await requireFreshSprintEngineAccess(window.api, setAuthState)
    } catch (error) {
      if (!authState.authenticated) await startLogin()
      throw new Error(error instanceof Error ? error.message : 'Sprint access could not be verified.')
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
          workspaceWindowId,
        },
        {
          filesystem: {
            ensureDir: window.api.ensureDir,
            readFile: window.api.readfile,
            writeFile: window.api.writefile,
          },
          pathExists: window.api.pathExists,
          // Fail-closed Advanced setup preflight: the controller awaits this
          // before writing the handoff or creating the run, so an MCP/skill
          // failure aborts without leaving a partial Sprint Engine workspace.
          persistAdvancedSetup,
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
      throw error instanceof Error ? error : new Error('Could not create the sprint workspace.')
    }
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
      className="relative isolate flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] outline-none"
    >
      <CreationBackdrop surface="workspace" />
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
            cliOptions={sprintEngineCliOptions}
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
        <WizardProgress
          total={steps.length}
          active={stepIndex}
          currentStepLabel={stepHeading.title}
          stepLabels={stepLabels}
          onStepSelect={jumpToStep}
        />
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
          className={`mx-auto flex w-full ${step === 'sprintengine-roster' ? 'max-w-[1040px]' : step === 'mode' ? 'max-w-[760px]' : 'max-w-[520px]'} flex-col gap-7 px-6 pt-10 pb-14 ${stepAnimationClass}`}
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
              folderDraftPath={folderDraftPath}
              onChangeFolderDraftPath={handleChangeFolderDraftPath}
              onBrowseFolder={() => void pickFolder()}
              folderDraftExists={folderDraftExists}
              folderError={folderError}
              onSelectRecent={handleSelectRecentFolder}
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

          {step === 'mode' && isChat ? (
            // Chat's config region: the same AgentComposer the standalone New chat
            // panel wraps. It carries its own project chip and Start-chat action, so
            // the wizard hides its shared footer for this step (below) to avoid a
            // duplicate CTA. Confirm routes to the host's solo-chat create path.
            <div className="h-[min(560px,62vh)] overflow-hidden rounded-lg border border-[color:var(--border-default)]">
              <AgentComposer
                folderPath={folderPath}
                folderLabel={folderPath ? basename(folderPath) : null}
                projectOptions={chatComposer.projectOptions}
                onSelectProject={handleChatSelectProject}
                onBrowseProject={() => void handleChatBrowseProject()}
                initialSelection={chatComposer.initialSelection}
                permissionPreset={chatComposer.permissionPreset}
                onChangePermissionPreset={chatComposer.onChangePermissionPreset}
                debugMode={chatComposer.debugMode}
                onChangeDebugMode={chatComposer.onChangeDebugMode}
                onConfirm={(confirm) => chatComposer.onConfirm(confirm, folderPath)}
                onClose={requestClose}
                embedded
              />
            </div>
          ) : null}

          {step === 'standard-layout' ? (
            <StandardLayoutStep
              layoutId={layoutId}
              onChange={setLayoutId}
              userTemplates={userLayoutTemplates}
              onTemplatesChanged={loadUserLayoutTemplates}
            />
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
              backlogScan={backlogScan.result}
              backlogScanning={backlogScan.isScanning}
              sourceFromFile={seSourceFromFile}
              onSelectBacklogItem={handleSelectBacklogItem}
              onChooseFile={() => void handlePickSourceFile()}
              onBackToBacklog={handleBackToBacklog}
              path={sePath}
              onChangePath={(p) => {
                setSePath(p)
                setSeExistingTeam(null)
                setSeAgentCliOverrides({})
                if (p !== 'plan') {
                  setSePlanPath('')
                  setSePlanRelativePath('')
                  setSePlanContent(null)
                  setSeSourcePlanKind('unknown')
                  setSeSourceBundle(null)
                  setSeSourceFromFile(false)
                }
                setSePlanError(null)
              }}
              planPath={sePlanPath}
              planRelativePath={sePlanRelativePath}
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
              preset={guidedPreset}
              onChangePreset={handleChangeGuidedPreset}
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
              seedMode={guidedSeedMode}
              onChangeSeedMode={(value) => {
                setGuidedSeedMode(value)
                setGuidedError(null)
              }}
              seedFolderPath={guidedSeedFolderPath}
              onChooseSeedFolder={() => void handleChooseGuidedSeedFolder()}
              brandDemo={guidedBrandDemo}
              wantsProductDiscussion={guidedWantsProduct}
              wantsArchitectureDiscussion={guidedWantsArchitecture}
              wantsFrontendDiscussion={guidedWantsFrontend}
              roleCliDefaults={guidedRoleCliDefaults}
              roleModelOverrides={guidedRoleModelOverrides}
              cliOptions={sprintEngineCliOptions}
              onChangeWantsProductDiscussion={setGuidedWantsProduct}
              onChangeWantsArchitectureDiscussion={setGuidedWantsArchitecture}
              onChangeWantsFrontendDiscussion={setGuidedWantsFrontend}
              onSetRoleCli={setGuidedRoleCli}
              onSetRoleModel={setGuidedRoleModel}
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
              roleModelOverrides={seRoleModelOverrides}
              onSetRoleModel={setRoleModel}
              automationMode={seAutomationMode}
              onChangeAutomationMode={setSeAutomationMode}
              cliPermissionPreset={cliPermissionPreset}
              onChangeCliPermissionPreset={setCliPermissionPreset}
              useWorktrees={seUseWorktrees}
              onChangeUseWorktrees={setSeUseWorktrees}
              worktreesDisabled={seExistingTeam != null}
              maxParallelAgents={seMaxParallelAgents}
              onChangeMaxParallelAgents={setSeMaxParallelAgents}
              totalAgents={totalAgents}
              hasExistingTeam={seExistingTeam != null}
              existingTeamName={seExistingTeam?.displayName ?? null}
              createError={sePlanError}
              teams={sprintEngineTeams}
              selectedTeamId={seSelectedTeamId}
              selectedTeamDirty={selectedSprintEngineTeamDirty}
              onSelectTeam={handleSelectSprintEngineTeam}
              onSaveTeam={handleSaveSprintEngineTeam}
              onUpdateTeam={handleUpdateSprintEngineTeam}
              onRenameTeam={handleRenameSprintEngineTeam}
              onDeleteTeam={handleDeleteSprintEngineTeam}
            />
          ) : null}

          {showAdvancedSetup ? (
            <AdvancedSetupDisclosure
              mcpCatalog={integrationsMcpCatalog}
              mcpSettings={mcpSettings ?? null}
              onToggleMcp={toggleMcpInWizard}
              skillPackCatalog={integrationsSkillPackCatalog}
              selectedSkillPackIds={selectedSkillPackIds}
              onToggleSkillPack={toggleSkillPackInWizard}
              integrationsMessage={integrationsMessage}
              knowledgeProjectRoot={folderPath && knowledgeStepEligible ? folderPath : null}
              committedKnowledgeRoot={committedKnowledgeRoot}
              onCommitKnowledge={handleCommitKnowledgeRoot}
              knowledgeAutoAppliedRef={knowledgeAutoAppliedRef}
              designSystemAttachRoot={designSystemAttachEligible && folderPath ? folderPath : null}
              designSystemAttachSelection={dsAttachSelection}
              onSelectDesignSystemAttach={(source) => {
                setDsAttachSelection(source)
                setAdvancedSetupError(null)
              }}
            />
          ) : null}

          {advancedSetupError ? (
            <div
              role="alert"
              className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]"
            >
              {advancedSetupError}
            </div>
          ) : null}

          {step === 'mode' && isChat ? null : (
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
          )}
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
  folderDraftPath,
  onChangeFolderDraftPath,
  onBrowseFolder,
  folderDraftExists,
  folderError,
  onSelectRecent,
  recentFolders,
  folderHints,
  inputRef,
}: {
  name: string
  onChangeName: (value: string) => void
  folderDraftPath: string
  onChangeFolderDraftPath: (value: string) => void
  onBrowseFolder: () => void
  folderDraftExists: boolean | null
  folderError: string | null
  onSelectRecent: (path: string) => void
  recentFolders: string[]
  folderHints: ReturnType<typeof useFolderHints>
  inputRef: React.MutableRefObject<HTMLInputElement | null>
}) {
  const trimmedPath = folderDraftPath.trim()
  // Existing folders open as-is regardless of leaf naming; otherwise the path
  // must be structurally valid to be created, so surface that error instead of
  // implying a folder will be made.
  const targetError =
    folderDraftExists === true ? null : trimmedPath ? analyzeWorkspaceTargetPath(folderDraftPath).error : null
  const status: { tone: 'error' | 'muted'; text: string } | null = folderError
    ? { tone: 'error', text: folderError }
    : !trimmedPath
      ? null
      : folderDraftExists === true
        ? { tone: 'muted', text: 'Existing folder — opens as-is.' }
        : targetError
          ? { tone: 'muted', text: targetError }
          : folderDraftExists === false
            ? { tone: 'muted', text: 'New — this folder will be created on continue.' }
            : null

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
        <div className="flex items-center gap-2">
          <input
            value={folderDraftPath}
            onChange={(event) => onChangeFolderDraftPath(event.target.value)}
            placeholder="/path/to/workspace"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={folderError ? true : undefined}
            className={`
              block h-11 w-full min-w-0 flex-1 rounded-md border bg-[color:var(--bg-surface)] px-3.5
              font-mono text-[12px] text-[color:var(--text-strong)] outline-none transition-colors
              placeholder:text-[color:var(--text-disabled)]
              hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
              ${folderError ? 'border-[color:var(--tone-error)]' : 'border-[color:var(--border-default)]'}
            `}
          />
          <GhostButton size="md" onClick={onBrowseFolder}>
            Browse
          </GhostButton>
        </div>
        {status ? (
          <p
            className={`px-0.5 text-[11px] leading-4 ${
              status.tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'
            }`}
          >
            {status.text}
          </p>
        ) : null}
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
                  active={isSameFolder(folderDraftPath, recent)}
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
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // guided-brief hands its build off to a Sprint Engine run, so it depends on
  // the sprint-engine module and is hidden when Sprint Engine is disabled.
  const sprintEngineEnabled = selectModuleEnabled(moduleOverrides, 'sprint-engine')

  // 'standard' (shell-owned) plus the enabled registry-contributed types, in
  // pickerOrder. getWorkspaceTypes returns a fresh array, so the derived list is
  // memoised from the stable moduleOverrides reference (Zustand v5: selectors and
  // selector-derived arrays must not return fresh arrays/objects each render).
  // Each definition's moduleId drives gating, so disabling sprint-engine drops
  // both sprintengine and guided-brief, exactly as the prior hardcoded list did.
  const modeModels = useMemo<ModeCardModel[]>(() => {
    const contributed = getRendererHost()
      .getWorkspaceTypes((moduleId) => selectModuleEnabled(moduleOverrides, moduleId))
      .map<ModeCardModel>((definition) => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        icon: definition.icon,
      }))
    // Lead with the shell-owned Chat pseudo-card, then surface Sprint Engine and
    // Design Wizard ahead of the rest (both gated by the sprint-engine module, so
    // absent when it is disabled). The remaining contributed types keep their
    // pickerOrder after the shell-owned Standard card.
    const featuredIds = ['sprintengine', 'guided-brief']
    const byId = new Map(contributed.map((model) => [model.id, model]))
    const featured = featuredIds
      .map((id) => byId.get(id))
      .filter((model): model is ModeCardModel => model !== undefined)
    const rest = contributed.filter((model) => !featuredIds.includes(model.id))
    return [CHAT_MODE_MODEL, ...featured, STANDARD_MODE_MODEL, ...rest]
  }, [moduleOverrides])

  const suggested: CreationMode | null = (() => {
    if (!folderHint) return null
    if (folderHint.hasSprintEngineTeam) return sprintEngineEnabled ? 'sprintengine' : null
    if (folderHint.hasMultiloop) return selectModuleEnabled(moduleOverrides, 'multiloop') ? 'multiloop' : null
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
      <div role="radiogroup" aria-label="Workspace type" className="grid grid-cols-3 gap-2.5">
        {modeModels.map((model) => (
          <ModeCard key={model.id} model={model} active={mode === model.id} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

// Opt-in advanced configuration on the wizard's final step (never the 'mode'
// pivot — see showAdvancedSetup). The novice critical path no longer gates on
// MCP servers / skill packs / knowledge (see creationStepFlows), but power users
// keep one-place in-wizard access here without seeing the jargon
// unless they ask for it. Collapsed by default; a selection count surfaces when
// the user has chosen anything so a returning expander isn't a surprise. Each
// section reuses the same component the standalone steps used, so behavior and
// persistence are identical — selections still write to project settings.
function AdvancedSetupDisclosure({
  mcpCatalog,
  mcpSettings,
  onToggleMcp,
  skillPackCatalog,
  selectedSkillPackIds,
  onToggleSkillPack,
  integrationsMessage,
  knowledgeProjectRoot,
  committedKnowledgeRoot,
  onCommitKnowledge,
  knowledgeAutoAppliedRef,
  designSystemAttachRoot,
  designSystemAttachSelection,
  onSelectDesignSystemAttach,
}: {
  mcpCatalog: McpCatalogServer[]
  mcpSettings: { servers: Record<string, { enabled: boolean }> } | null
  onToggleMcp: (server: McpCatalogServer) => void
  skillPackCatalog: SkillPackCatalogEntry[]
  selectedSkillPackIds: Set<string>
  onToggleSkillPack: (pack: SkillPackCatalogEntry) => void
  integrationsMessage: string | null
  knowledgeProjectRoot: string | null
  committedKnowledgeRoot: string | null
  onCommitKnowledge: (relativeRoot: string | null) => void
  knowledgeAutoAppliedRef: MutableRefObject<Set<string>>
  /** Materialized workspace folder when the flow offers attach; null hides the section. */
  designSystemAttachRoot: string | null
  designSystemAttachSelection: DesignSystemAttachSource | null
  onSelectDesignSystemAttach: (source: DesignSystemAttachSource | null) => void
}) {
  const [open, setOpen] = useState(false)
  const selectedCount =
    mcpCatalog.reduce((count, server) => count + (mcpSettings?.servers[server.id]?.enabled ? 1 : 0), 0) +
    skillPackCatalog.reduce((count, pack) => count + (selectedSkillPackIds.has(pack.id) ? 1 : 0), 0) +
    (designSystemAttachSelection ? 1 : 0)

  return (
    <div className="border-t border-[color:var(--border-subtle)] pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="
          flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors
          hover:bg-[color:var(--bg-surface-raised)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        "
      >
        <svg
          className={`icon-sm shrink-0 text-[color:var(--text-subtle)] transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13px] font-medium text-[color:var(--text-strong)]">Advanced setup</span>
        <span className="min-w-0 truncate text-[12px] text-[color:var(--text-subtle)]">
          Tool integrations and skill packs{knowledgeProjectRoot ? ', knowledge' : ''}{designSystemAttachRoot ? ', design system' : ''} — optional
        </span>
        {selectedCount > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-6 px-1.5 pt-4">
          <section className="flex flex-col gap-2">
            <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Tool integrations</h4>
            <McpServersStep
              mcpCatalog={mcpCatalog}
              mcpSettings={mcpSettings}
              onToggleMcp={onToggleMcp}
              message={integrationsMessage}
            />
          </section>
          <section className="flex flex-col gap-2">
            <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Skill packs</h4>
            <SkillPacksStep
              skillPackCatalog={skillPackCatalog}
              selectedSkillPackIds={selectedSkillPackIds}
              onToggleSkillPack={onToggleSkillPack}
              message={integrationsMessage}
            />
          </section>
          {knowledgeProjectRoot ? (
            <section className="flex flex-col gap-2">
              <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Knowledge graph</h4>
              <KnowledgeStep
                projectRoot={knowledgeProjectRoot}
                committedRelativeRoot={committedKnowledgeRoot}
                onCommit={onCommitKnowledge}
                autoApplyGuard={knowledgeAutoAppliedRef}
              />
            </section>
          ) : null}
          {designSystemAttachRoot ? (
            <section className="flex flex-col gap-2">
              <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Design system</h4>
              <DesignSystemAttachStep
                workspaceRoot={designSystemAttachRoot}
                selection={designSystemAttachSelection}
                onSelect={onSelectDesignSystemAttach}
              />
            </section>
          ) : null}
        </div>
      ) : null}
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
          Selected tools are added to this project when you create it. Manage them anytime in Settings.
        </p>
        {mcpCatalog.length > 0 ? (
          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </div>
      {mcpCatalog.length === 0 ? (
        <p className="text-[11px] text-[color:var(--text-subtle)]">Loading…</p>
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
                    <TruncatedText
                      as="span"
                      text={server.name}
                      className="block text-[13px] font-semibold text-[color:var(--text-strong)]"
                    />
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
          Each selected pack is added to this project when you create it, ready for your agents to use.
        </p>
        {skillPackCatalog.length > 0 ? (
          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </div>
      {skillPackCatalog.length === 0 ? (
        <p className="text-[11px] text-[color:var(--text-subtle)]">Loading…</p>
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
                    <TruncatedText
                      as="span"
                      text={pack.name}
                      className="block text-[13px] font-semibold text-[color:var(--text-strong)]"
                    />
                    <TruncatedText
                      as="span"
                      text={pack.slug}
                      className="mt-0.5 block font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]"
                    />
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

function LayoutTemplateRadio({
  template,
  active,
  onChange,
}: {
  template: LayoutTemplate
  active: boolean
  onChange: (id: string) => void
}) {
  return (
    <button
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
}

function StandardLayoutStep({
  layoutId,
  onChange,
  userTemplates,
  onTemplatesChanged,
}: {
  layoutId: string
  onChange: (id: string) => void
  userTemplates: LayoutTemplate[]
  onTemplatesChanged: () => void
}) {
  const [installing, setInstalling] = useState(false)
  const [installMessage, setInstallMessage] = useState<{ tone: 'accent' | 'warn' | 'error'; text: string } | null>(null)

  const installTemplateFolder = async () => {
    if (typeof window.api.installUserLayoutTemplateFolder !== 'function') return
    setInstalling(true)
    setInstallMessage(null)
    try {
      const folder = await window.api.openDir()
      if (!folder) return
      const result = await window.api.installUserLayoutTemplateFolder(folder)
      const rejected = result.rejected.length
      if (!result.ok && result.installed.length === 0) {
        setInstallMessage({
          tone: 'error',
          text:
            result.message
            ?? (rejected > 0 ? `${rejected} template${rejected === 1 ? '' : 's'} rejected as invalid.` : 'Nothing to install.'),
        })
      } else {
        const summary = `${result.installed.length} template${result.installed.length === 1 ? '' : 's'} installed`
        setInstallMessage({
          tone: rejected > 0 ? 'warn' : 'accent',
          text: rejected > 0 ? `${summary}, ${rejected} rejected.` : `${summary}.`,
        })
      }
      onTemplatesChanged()
    } catch (error) {
      setInstallMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Install failed.' })
    } finally {
      setInstalling(false)
    }
  }

  // Match the panel's existing inline-message idiom (border-l-2 + tone), as used
  // for plan/create errors elsewhere in this file.
  const messageClass =
    installMessage?.tone === 'error'
      ? 'border-[color:var(--tone-error)] text-[color:var(--tone-error)]'
      : installMessage?.tone === 'warn'
        ? 'border-[color:var(--tone-warn)] text-[color:var(--tone-warn)]'
        : 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]'

  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="IDE layout" className="flex flex-col gap-1.5">
        {LAYOUT_TEMPLATES.map((template) => (
          <LayoutTemplateRadio key={template.id} template={template} active={template.id === layoutId} onChange={onChange} />
        ))}
        {userTemplates.length > 0 ? (
          <>
            <div className="mt-2 text-[11px] font-medium text-[color:var(--text-subtle)]">Installed templates</div>
            {userTemplates.map((template) => (
              <LayoutTemplateRadio key={template.id} template={template} active={template.id === layoutId} onChange={onChange} />
            ))}
          </>
        ) : null}
      </div>
      <div className="mt-1 flex flex-col gap-2">
        <GhostButton size="sm" onClick={() => void installTemplateFolder()} disabled={installing} className="self-start">
          {installing ? 'Installing' : 'Install template from folder'}
        </GhostButton>
        {installMessage ? (
          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${messageClass}`}>{installMessage.text}</div>
        ) : null}
      </div>
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

// Per-preset wizard copy for the guided-idea step. `lockedDesigner` doubles as
// the studio-preset switch: when set, the has-UI question is skipped and the
// designer discussion is pinned on (the controller forces the matching flags).
type GuidedPresetCopy = {
  cardTitle: string
  cardBody: string
  ideaLabel: string
  ideaPlaceholder: string
  ideaHint: string
  lockedDesigner: { title: string; body: string } | null
  studioNote: string | null
  folderHint: { before: string; path: string; after: string }
}

const GUIDED_PRESET_ORDER: GuidedBriefPreset[] = ['full-brief', 'frontend-design', 'design-system']

// Starting-point choice for the design-system preset. 'blank' scaffolds the
// empty bundle; the seed modes make the designer's opening move a reviewed
// extraction from an existing source (see DesignSystemSeedSource).
type DesignSystemSeedMode = 'blank' | 'source-folder' | 'brand-demo'

const GUIDED_PRESET_COPY: Record<GuidedBriefPreset, GuidedPresetCopy> = {
  'full-brief': {
    cardTitle: 'Plan & design',
    cardBody: 'Think it through, then design it — strategy, plan, and screens before the build.',
    ideaLabel: 'Rough idea',
    ideaPlaceholder: 'A shift-trading app where café staff can swap shifts without texting the manager.',
    ideaHint: 'Plain English. Spelling doesn’t matter.',
    lockedDesigner: null,
    studioNote: null,
    folderHint: {
      before: 'Idea seed will be written to ',
      path: 'product/idea-seed.md',
      after: ' in the selected folder.',
    },
  },
  'frontend-design': {
    cardTitle: 'Design only',
    cardBody: 'Skip the planning and go straight to screens and mockups.',
    ideaLabel: 'Design goal',
    ideaPlaceholder:
      'A calm onboarding flow for a café shift-trading app: sign in, see this week’s shifts, request a swap.',
    ideaHint: 'Describe the screen or flow, the target user, and any brand constraints.',
    lockedDesigner: {
      title: 'Frontend engineer',
      body: 'Designs the screens and reviewable mockups.',
    },
    studioNote:
      'Design only skips the strategy and planning discussions and starts straight in the design studio.',
    folderHint: {
      before: 'Idea seed will be written to ',
      path: 'product/idea-seed.md',
      after: ' in the selected folder.',
    },
  },
  'design-system': {
    cardTitle: 'UX design system',
    cardBody: 'Author a reusable system — tokens, components, patterns — as a portable bundle.',
    ideaLabel: 'UX design system goal',
    ideaPlaceholder:
      'A warm, editorial design system for a café brand: friendly type, calm surfaces, light and dark modes.',
    ideaHint:
      'Describe the brand character, the products it will serve, and any constraints — fonts, colors, density.',
    lockedDesigner: {
      title: 'UX designer',
      body: 'Interviews through the brand and authors the tokens, components, and patterns.',
    },
    studioNote:
      'UX design system skips the planning discussions and starts straight in the authoring studio.',
    folderHint: {
      before: 'The bundle will be scaffolded into ',
      path: 'design-system/',
      after: ' in the selected folder.',
    },
  },
}

// Effective launch model for a guided role: explicit override (string) wins;
// null (explicit CLI default) or an absent role resolves to undefined (no model
// flag). Mirrors effectiveRoleModel in the Sprint Engine roster.
function guidedEffectiveRoleModel(
  role: keyof GuidedBriefRoleCliDefaults,
  roleModelOverrides: GuidedBriefRoleModelOverrides,
): string | undefined {
  const override = roleModelOverrides[role]
  return typeof override === 'string' ? override : undefined
}

function GuidedIdeaStep({
  idea,
  preset,
  onChangePreset,
  hasUi,
  onChangeIdea,
  onChangeHasUi,
  seedMode,
  onChangeSeedMode,
  seedFolderPath,
  onChooseSeedFolder,
  brandDemo,
  wantsProductDiscussion,
  wantsArchitectureDiscussion,
  wantsFrontendDiscussion,
  roleCliDefaults,
  roleModelOverrides,
  cliOptions,
  onChangeWantsProductDiscussion,
  onChangeWantsArchitectureDiscussion,
  onChangeWantsFrontendDiscussion,
  onSetRoleCli,
  onSetRoleModel,
  folderPath,
  error,
}: {
  idea: string
  preset: GuidedBriefPreset
  onChangePreset: (value: GuidedBriefPreset) => void
  hasUi: GuidedBriefHasUi | null
  onChangeIdea: (value: string) => void
  onChangeHasUi: (value: GuidedBriefHasUi) => void
  seedMode: DesignSystemSeedMode
  onChangeSeedMode: (value: DesignSystemSeedMode) => void
  seedFolderPath: string | null
  onChooseSeedFolder: () => void
  brandDemo: DesignSystemBrandDemoResolveResult | null
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  roleCliDefaults: GuidedBriefRoleCliDefaults
  roleModelOverrides: GuidedBriefRoleModelOverrides
  cliOptions: SprintEngineCliOption[]
  onChangeWantsProductDiscussion: (value: boolean) => void
  onChangeWantsArchitectureDiscussion: (value: boolean) => void
  onChangeWantsFrontendDiscussion: (value: boolean) => void
  onSetRoleCli: (role: keyof GuidedBriefRoleCliDefaults, cli: AgentCli) => void
  onSetRoleModel: (role: keyof GuidedBriefRoleCliDefaults, model: string | null) => void
  folderPath: string | null
  error: string | null
}) {
  const copy = GUIDED_PRESET_COPY[preset]
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <FieldLabel>What are we making?</FieldLabel>
        <div role="group" aria-label="Design Wizard mode" className="grid grid-cols-3 gap-2.5">
          {GUIDED_PRESET_ORDER.map((presetOption) => (
            <GuidedChoiceCard
              key={presetOption}
              active={preset === presetOption}
              title={GUIDED_PRESET_COPY[presetOption].cardTitle}
              body={GUIDED_PRESET_COPY[presetOption].cardBody}
              onSelect={() => onChangePreset(presetOption)}
            />
          ))}
        </div>
      </div>

      {preset === 'design-system' ? (
        <div className="flex flex-col gap-2">
          <FieldLabel>Starting point</FieldLabel>
          <div role="group" aria-label="Design system starting point" className="grid grid-cols-3 gap-2.5">
            <GuidedChoiceCard
              active={seedMode === 'blank'}
              title="Start blank"
              body="Author the system from scratch in the studio."
              onSelect={() => onChangeSeedMode('blank')}
            />
            <GuidedChoiceCard
              active={seedMode === 'source-folder'}
              title="Seed from a product"
              body="The designer extracts a repo's de-facto tokens, glyphs, and components for review."
              onSelect={() => onChangeSeedMode('source-folder')}
            />
            <GuidedChoiceCard
              active={seedMode === 'brand-demo'}
              title="Multicode brand demo"
              body={
                brandDemo == null
                  ? 'Checking availability…'
                  : brandDemo.ok
                    ? 'Seed from the built-in Multicode brand reference.'
                    : brandDemo.message
              }
              disabled={brandDemo == null || !brandDemo.ok}
              onSelect={() => onChangeSeedMode('brand-demo')}
            />
          </div>
          {seedMode === 'source-folder' ? (
            <>
              <div className="flex items-center gap-3">
                <span
                  className={`min-w-0 flex-1 truncate rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 font-mono text-[12px] leading-5 ${
                    seedFolderPath
                      ? 'text-[color:var(--text-default)]'
                      : 'text-[color:var(--text-disabled)]'
                  }`}
                >
                  {seedFolderPath ?? 'No source folder chosen'}
                </span>
                <GhostButton
                  size="md"
                  onClick={onChooseSeedFolder}
                  className="shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                >
                  Choose…
                </GhostButton>
              </div>
              <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
                The designer reads this folder’s stylesheets and assets, then drafts tokens, glyphs, and components for your review — nothing lands unreviewed.
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-2">
        <FieldLabel>{copy.ideaLabel}</FieldLabel>
        <textarea
          value={idea}
          onChange={(event) => onChangeIdea(event.target.value)}
          placeholder={copy.ideaPlaceholder}
          autoFocus
          className="
            min-h-[140px] w-full resize-none rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3.5 py-3
            text-[14px] leading-6 text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
        <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{copy.ideaHint}</span>
      </label>

      {copy.lockedDesigner ? null : (
        <div className="flex flex-col gap-2">
          <FieldLabel>Will people use it on a screen?</FieldLabel>
          <div role="group" aria-label="App surface" className="grid grid-cols-2 gap-2.5">
            <GuidedChoiceCard
              active={hasUi === 'yes'}
              title="Yes, it has a screen"
              body="App, dashboard, mobile screen, internal tool."
              onSelect={() => onChangeHasUi('yes')}
            />
            <GuidedChoiceCard
              active={hasUi === 'no'}
              title="No, script or service"
              body="Command-line tool, data service, or scheduled job — runs in the background."
              onSelect={() => onChangeHasUi('no')}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <FieldLabel>Guided discussions</FieldLabel>
        <div className="flex flex-col gap-2">
          {copy.lockedDesigner ? (
            <GuidedRoleToggle
              checked
              locked
              title={copy.lockedDesigner.title}
              body={copy.lockedDesigner.body}
              cli={roleCliDefaults.frontend}
              cliOptions={cliOptions}
              model={guidedEffectiveRoleModel('frontend', roleModelOverrides)}
              onChangeCli={(cli) => onSetRoleCli('frontend', cli)}
              onChangeModel={(model) => onSetRoleModel('frontend', model)}
              onChange={onChangeWantsFrontendDiscussion}
            />
          ) : (
            <>
              <GuidedRoleToggle
                checked={wantsProductDiscussion}
                title="Product strategist"
                body="Sharpens the product brief before planning."
                cli={roleCliDefaults.product}
                cliOptions={cliOptions}
                model={guidedEffectiveRoleModel('product', roleModelOverrides)}
                onChangeCli={(cli) => onSetRoleCli('product', cli)}
                onChangeModel={(model) => onSetRoleModel('product', model)}
                onChange={onChangeWantsProductDiscussion}
              />
              <GuidedRoleToggle
                checked={wantsArchitectureDiscussion}
                title="Architect"
                body="Interviews through architecture decisions and writes architecture/plan.md."
                cli={roleCliDefaults.architect}
                cliOptions={cliOptions}
                model={guidedEffectiveRoleModel('architect', roleModelOverrides)}
                onChangeCli={(cli) => onSetRoleCli('architect', cli)}
                onChangeModel={(model) => onSetRoleModel('architect', model)}
                onChange={onChangeWantsArchitectureDiscussion}
              />
              <GuidedRoleToggle
                checked={hasUi === 'yes' && wantsFrontendDiscussion}
                disabled={hasUi !== 'yes'}
                title="Frontend engineer"
                body={hasUi === 'yes' ? 'Designs the screens and reviewable mockups.' : 'Available only for visual apps.'}
                cli={roleCliDefaults.frontend}
                cliOptions={cliOptions}
                model={guidedEffectiveRoleModel('frontend', roleModelOverrides)}
                onChangeCli={(cli) => onSetRoleCli('frontend', cli)}
                onChangeModel={(model) => onSetRoleModel('frontend', model)}
                onChange={onChangeWantsFrontendDiscussion}
              />
            </>
          )}
        </div>
        {copy.studioNote ? (
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">{copy.studioNote}</p>
        ) : null}
      </div>

      {folderPath ? (
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          {copy.folderHint.before}
          <span className="font-mono text-[color:var(--text-default)]">{copy.folderHint.path}</span>
          {copy.folderHint.after}
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
  locked = false,
  title,
  body,
  cli,
  cliOptions,
  model,
  onChange,
  onChangeCli,
  onChangeModel,
}: {
  checked: boolean
  disabled?: boolean
  // `locked` pins the discussion on (checkbox checked, not toggleable) while
  // keeping the runtime selector usable. Used by the Multicode Design preset,
  // which always runs the frontend designer but still lets the user pick its
  // CLI and model.
  locked?: boolean
  title: string
  body: string
  cli: AgentCli
  cliOptions: SprintEngineCliOption[]
  // Effective launch model for the current CLI (undefined = CLI default).
  model?: string
  onChange: (value: boolean) => void
  onChangeCli: (cli: AgentCli) => void
  onChangeModel: (model: string | null) => void
}) {
  const effectiveChecked = locked || checked
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
        <CliModelPickerButton
          ariaLabel={`${title} agent runtime`}
          options={cliOptions}
          cli={cli}
          disabled={disabled || !effectiveChecked}
          effectiveModelFor={(candidateCli) => (candidateCli === cli ? model : undefined)}
          onSelectCli={(nextCli) => {
            // Switching CLIs resets the model to that CLI's default: a model id
            // from the previous CLI is meaningless for the new one.
            if (nextCli !== cli) {
              onChangeCli(nextCli)
              onChangeModel(null)
            }
          }}
          onSelectModel={(nextCli, nextModel) => {
            if (nextCli !== cli) onChangeCli(nextCli)
            onChangeModel(nextModel)
          }}
        />
        <input
          type="checkbox"
          checked={effectiveChecked}
          disabled={disabled || locked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-[color:var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-primary)] disabled:cursor-not-allowed"
        />
      </span>
    </div>
  )
}

// Selection cards are aria-pressed toggle buttons in a labelled group, not
// role="radio": radio semantics promise arrow-key movement these Tab-navigated
// grids don't have, and some groups legitimately start with no selection
// (hasUi). Every grid that renders these cards must use role="group" with an
// aria-label so the announced role matches the actual keyboard behavior.
function GuidedChoiceCard({
  active,
  title,
  body,
  onSelect,
  disabled = false,
}: {
  active: boolean
  title: string
  body: string
  onSelect: () => void
  // Renders the option unavailable (the body copy should carry the cause).
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      className={`
        relative flex min-h-[88px] w-full flex-col items-start gap-1.5 overflow-hidden rounded-md border p-3 text-left
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        disabled:cursor-not-allowed disabled:opacity-55
        ${active
          ? 'border-[color:var(--accent-primary-soft-strong)] bg-[color:var(--accent-primary-soft)]'
          : disabled
            ? 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)]'
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

function SprintEngineAccessNotice({
  access,
  onSignIn,
}: {
  access: PremiumFeatureAccessState
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
          text-[12px] font-semibold text-[color:var(--bg-app)] transition-colors hover:bg-[color:var(--bg-inverted-hover)]
          focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        "
      >
        Sign in
      </button>
    </div>
  )
}

function BacklogPickerNote({ children, tone }: { children: ReactNode; tone?: 'error' }): JSX.Element {
  return (
    <div
      className={`
        rounded-md border border-dashed border-[color:var(--border-default)] px-3 py-4
        text-center text-[12px] leading-5
        ${tone === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-subtle)]'}
      `}
    >
      {children}
    </div>
  )
}

// Backlog as a first-class Sprint Engine source: the same scanBacklog() items the
// Backlog panel shows, rendered with the shared BacklogRowContent so the two
// surfaces can't drift. Each state (scanning, no folder, empty, unreadable,
// ready) has its own copy — a failed scan never reads as an empty backlog.
function BacklogSourcePicker({
  scan,
  scanning,
  selectedPath,
  onSelect,
}: {
  scan: BacklogScanResult
  scanning: boolean
  selectedPath: string
  onSelect: (item: BacklogItem) => void
}): JSX.Element {
  const now = useRelativeNow()
  // Most-recent first (by modifiedAt), matching the Backlog panel's default
  // 'recent' order. The raw scan is path-sorted (ascending id ≈ oldest first),
  // which surfaced stale items at the top.
  const sortedItems = useMemo(
    () => [...scan.items].sort((a, b) => compareBacklogItems(a, b, 'recent')),
    [scan.items],
  )
  // Bring an already-selected item into view when the picker opens: after the
  // recency sort a previously-picked older item can sit far down the scroll
  // area. `block: 'nearest'` only scrolls when it isn't already visible, so
  // clicking a visible row never yanks the list.
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (selectedPath && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedPath, sortedItems])
  if (scanning && scan.items.length === 0) {
    return <BacklogPickerNote>Scanning the backlog…</BacklogPickerNote>
  }
  if (scan.state === 'missing-folder') {
    return <BacklogPickerNote>No backlog/ folder in this project yet. Start a new team, or choose a file.</BacklogPickerNote>
  }
  if (scan.state === 'error') {
    const detail = scan.errors[0]
    return (
      <BacklogPickerNote tone="error">
        {detail ? `Couldn’t read the backlog: ${detail.message}` : 'Couldn’t read the backlog.'}
      </BacklogPickerNote>
    )
  }
  if (scan.items.length === 0) {
    return <BacklogPickerNote>Backlog is empty. Start a new team, or choose a file.</BacklogPickerNote>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-[280px] overflow-y-auto rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        {sortedItems.map((item) => {
          const selected = item.path === selectedPath
          return (
            <button
              key={item.id}
              ref={selected ? selectedRef : undefined}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(item)}
              className={`
                block w-full cursor-pointer border-b border-l-[3px] border-[color:var(--border-subtle)]
                px-3 py-2 text-left transition-colors last:border-b-0
                focus:outline-none focus-visible:ring-2 focus-visible:ring-inset
                focus-visible:ring-[color:var(--accent-primary)]
                ${
                  selected
                    ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] pl-[9px]'
                    : 'border-l-transparent hover:bg-[color:var(--bg-hover)]'
                }
              `}
            >
              <BacklogRowContent item={item} now={now} />
              {item.status === 'in_progress' || item.status === 'needs_input' ? (
                <div className="mt-1 truncate pl-[22px] text-[11px] leading-4 text-[color:var(--text-subtle)]">
                  {item.status === 'needs_input' ? 'In progress — awaiting input' : 'Already in progress'}
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
      {scan.state === 'partial' && scan.errors.length > 0 ? (
        <div className="text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {scan.errors.length} item{scan.errors.length === 1 ? '' : 's'} couldn’t be read.
        </div>
      ) : null}
    </div>
  )
}

function SprintEngineTeamStep(props: {
  access: PremiumFeatureAccessState
  onSignIn: () => void
  folderPath: string | null
  isScanning: boolean
  existingTeams: ExistingTeam[]
  backlogScan: BacklogScanResult
  backlogScanning: boolean
  sourceFromFile: boolean
  onSelectBacklogItem: (item: BacklogItem) => void
  onChooseFile: () => void
  onBackToBacklog: () => void
  path: SprintEnginePath
  onChangePath: (path: SprintEnginePath) => void
  planPath: string
  planRelativePath: string
  sourcePlanKind: SprintEngineSourcePlanKind
  onChangeSourcePlanKind: (kind: SprintEngineSourcePlanKind) => void
  sourceBundle: SprintEngineSourceBundleItem[] | null
  onChangeSourceBundleKind: (index: number, kind: SprintEngineSourceBundleKind) => void
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
    backlogScan,
    backlogScanning,
    sourceFromFile,
    onSelectBacklogItem,
    onChooseFile,
    onBackToBacklog,
    path,
    onChangePath,
    planPath,
    planRelativePath,
    sourcePlanKind,
    onChangeSourcePlanKind,
    sourceBundle,
    onChangeSourceBundleKind,
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

  const backlogItems = backlogScan.items
  const backlogCount = backlogItems.length
  const teamAvailable = existingTeams.length > 0
  const planKindLabel = SOURCE_PLAN_KIND_LABELS[sourcePlanKind]
  const hasSourceBundle = Boolean(sourceBundle?.length)

  return (
    <div className="flex flex-col gap-5">
      <div
        role="radiogroup"
        aria-label="Sprint starting point"
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
          disabled={!folderPath}
          label="Start from backlog"
          hint={
            backlogScanning
              ? 'Scanning the backlog…'
              : !folderPath
                ? 'Pick a folder to detect backlog items.'
                : backlogCount > 0
                  ? `${backlogCount} backlog item${backlogCount === 1 ? '' : 's'} in backlog/.`
                  : 'No backlog items yet — or choose a file.'
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
        sourceFromFile ? (
          // ---- Hand-picked file: a deliberate one-off outside the backlog. ----
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <FieldLabel>Source file</FieldLabel>
              <button
                type="button"
                onClick={onBackToBacklog}
                className="
                  rounded-sm text-[12px] leading-5 text-[color:var(--text-muted)] underline-offset-2
                  hover:text-[color:var(--text-default)] hover:underline focus:outline-none
                  focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                "
              >
                Back to backlog
              </button>
            </div>
            {hasSourceBundle ? (
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
                        <TruncatedText
                          as="div"
                          text={item.sourceRelativePath}
                          className="text-[12px] leading-5 text-[color:var(--text-default)]"
                        />
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
            ) : (
              <div className="flex items-center gap-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
                <TruncatedText
                  as="span"
                  text={planRelativePath || planBasename(planPath)}
                  className="min-w-0 flex-1 font-mono text-[11px] leading-5 text-[color:var(--text-default)]"
                />
                <button
                  type="button"
                  onClick={onChooseFile}
                  className="
                    shrink-0 rounded-sm text-[12px] leading-5 text-[color:var(--text-muted)] underline-offset-2
                    hover:text-[color:var(--text-default)] hover:underline focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  "
                >
                  Change
                </button>
              </div>
            )}
            {/* A hand-picked file's kind is genuinely inferred, so the override
                survives here (a backlog item already knows its kind). */}
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
          </div>
        ) : (
          // ---- Backlog list: the first-class source. ----
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <FieldLabel>Backlog item</FieldLabel>
              <button
                type="button"
                onClick={onChooseFile}
                className="
                  rounded-sm text-[12px] leading-5 text-[color:var(--text-muted)] underline-offset-2
                  hover:text-[color:var(--text-default)] hover:underline focus:outline-none
                  focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                "
              >
                Choose a file instead…
              </button>
            </div>
            <BacklogSourcePicker
              scan={backlogScan}
              scanning={backlogScanning}
              selectedPath={planPath}
              onSelect={onSelectBacklogItem}
            />
          </div>
        )
      ) : null}

      {planError ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {planError}
        </div>
      ) : null}

      {path !== 'existing' ? (
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
      ) : null}

      {path === 'new' ? (
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
      ) : null}
    </div>
  )
}

function SprintEngineRosterStep(props: {
  access: PremiumFeatureAccessState
  onSignIn: () => void
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  // Full catalog options: modelSelection drives the per-role model sublists.
  cliOptions: SprintEngineCliOption[]
  registry: SprintEngineRoleRegistry | null
  registryStatus: 'idle' | 'loading' | 'ready' | 'unavailable'
  disabledRoleIds: ReadonlySet<SprintEngineRoleId> | null
  rosterDisabled: boolean
  onSetRoleCount: (role: SprintEngineRoleId, count: number) => void
  onSetRoleCli: (role: SprintEngineRoleId, cli: AgentCli) => void
  roleModelOverrides: SprintEngineRoleModelOverrides
  onSetRoleModel: (role: SprintEngineRoleId, model: string | null) => void
  automationMode: SprintEngineAutomationMode
  onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onChangeCliPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  useWorktrees: boolean
  onChangeUseWorktrees: (value: boolean) => void
  worktreesDisabled: boolean
  maxParallelAgents: number
  onChangeMaxParallelAgents: (value: number) => void
  totalAgents: number
  hasExistingTeam: boolean
  existingTeamName: string | null
  createError: string | null
  teams: SprintEngineRosterTeam[]
  selectedTeamId: string | null
  selectedTeamDirty: boolean
  onSelectTeam: (id: string | null) => void
  onSaveTeam: (name: string) => void
  onUpdateTeam: (id: string, name: string) => void
  onRenameTeam: (id: string, name: string) => void
  onDeleteTeam: (id: string) => void
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
    roleModelOverrides,
    onSetRoleModel,
    automationMode,
    onChangeAutomationMode,
    cliPermissionPreset,
    onChangeCliPermissionPreset,
    useWorktrees,
    onChangeUseWorktrees,
    worktreesDisabled,
    maxParallelAgents,
    onChangeMaxParallelAgents,
    totalAgents,
    hasExistingTeam,
    existingTeamName,
    createError,
    teams,
    selectedTeamId,
    selectedTeamDirty,
    onSelectTeam,
    onSaveTeam,
    onUpdateTeam,
    onRenameTeam,
    onDeleteTeam,
  } = props

  if (!access.allowed) {
    return <SprintEngineAccessNotice access={access} onSignIn={onSignIn} />
  }

  return (
    <div className="flex flex-col gap-5">
      {hasExistingTeam ? (
        <p className="rounded-md border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
          Loading <span className="font-semibold">{existingTeamName}</span> — team size is read-only; the agent for each role can still be changed before launch.
        </p>
      ) : null}

      {createError ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {createError}
        </div>
      ) : null}

      <RosterAndRunSettings
        roleCounts={roleCounts}
        roleCliDefaults={roleCliDefaults}
        cliOptions={cliOptions}
        registry={registry}
        disabledRoleIds={disabledRoleIds}
        countDisabled={rosterDisabled}
        cliDisabled={false}
        onSetCount={onSetRoleCount}
        onSetCli={onSetRoleCli}
        roleModelOverrides={roleModelOverrides}
        onSetModel={onSetRoleModel}
        totalAgents={totalAgents}
        rosterCountLabel={registryStatus === 'loading' ? 'Loading roles' : undefined}
        teams={teams}
        selectedTeamId={selectedTeamId}
        selectedTeamDirty={selectedTeamDirty}
        onSelectTeam={onSelectTeam}
        onSaveTeam={onSaveTeam}
        onUpdateTeam={onUpdateTeam}
        onRenameTeam={onRenameTeam}
        onDeleteTeam={onDeleteTeam}
        automationMode={automationMode}
        onChangeAutomationMode={onChangeAutomationMode}
        cliPermissionPreset={cliPermissionPreset}
        onChangeCliPermissionPreset={onChangeCliPermissionPreset}
        useWorktrees={useWorktrees}
        onChangeUseWorktrees={onChangeUseWorktrees}
        worktreesDisabled={worktreesDisabled}
        maxParallelAgents={maxParallelAgents}
        onChangeMaxParallelAgents={onChangeMaxParallelAgents}
      />
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
    case 'plan-not-on-disk':
      return 'Selected source file is not available.'
    case 'team-exists':
      return 'A sprint roster with this name already exists.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the sprint workspace.'
  }
}

function newTeamCreationErrorMessage(error: SprintEngineNewTeamCreationError): string {
  switch (error.code) {
    case 'missing-folder':
      return 'Pick a folder before creating the sprint workspace.'
    case 'team-exists':
      return 'A sprint roster with this name already exists.'
    case 'init-failed':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not initialize the sprint run state.'
    case 'invalid-projection':
      return 'The sprint initialized but did not return a readable run projection.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the sprint workspace.'
  }
}

function guidedBriefStartBuildErrorMessage(error: GuidedBriefStartBuildError): string {
  switch (error.code) {
    case 'missing-product-brief':
      return 'Accept the product brief before starting the build.'
    case 'missing-architecture-plan':
      return 'Accept the architecture plan before starting the build.'
    case 'missing-ui-direction-or-mockups':
      return 'Accept the screen design and mockups before starting the build.'
    case 'design-system-preset':
      return 'A design-system studio releases a bundle; it never starts a Sprint Engine build.'
    case 'advanced-setup-failed':
      // Carries the actionable persistAdvancedSetup message verbatim.
      return error.message && error.message !== error.code
        ? error.message
        : 'Advanced setup could not be applied. No workspace was created.'
    case 'team-exists':
      return 'A sprint roster with this name already exists.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the sprint workspace.'
  }
}

function labelFor(mode: CreationMode): string {
  if (mode === 'standard') return 'Standard'
  // Contributed types carry their own label; fall back to the id for an
  // unrecognised mode rather than throwing on the open CreationMode union.
  return getRendererHost().getWorkspaceType(mode)?.label ?? mode
}

function createLabelFor(mode: CreationMode, isCreating: boolean, hasExistingTeam: boolean): string {
  if (isCreating) return 'Creating…'
  if (mode === 'sprintengine' && hasExistingTeam) return 'Load team'
  switch (mode) {
    // 'chat' drives create from the embedded composer's own CTA, not this footer,
    // so the footer is hidden for it; the label is defined for completeness.
    case 'chat':
      return 'Start chat'
    case 'sprintengine':
      return 'Start sprint'
    case 'switchboard':
      return 'Create Switchboard'
    case 'multiloop':
      return 'Create Multiloop'
    case 'guided-brief':
      return 'Start design'
    case 'standard':
      return 'Create workspace'
    default:
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
    case 'knowledge':
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
  workspaceFolderReady: boolean
  name: string
  mlGoal: string
  sprintEngineAccess: PremiumFeatureAccessState
  sePath: SprintEnginePath
  sePlanReady: boolean
  seExistingTeam: ExistingTeam | null
  seTeamDetailsReady: boolean
  totalAgents: number
  guidedIdea: string
  guidedHasUi: GuidedBriefHasUi | null
  guidedSeedMode: DesignSystemSeedMode
  guidedSeedReady: boolean
  committedKnowledgeRoot: string | null
}): string {
  const {
    step,
    mode,
    workspaceFolderReady,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seTeamDetailsReady,
    totalAgents,
    guidedIdea,
    guidedHasUi,
    guidedSeedMode,
    guidedSeedReady,
    committedKnowledgeRoot,
  } = args

  switch (step) {
    case 'workspace':
      if (!workspaceFolderReady && !name.trim()) return 'Add a name and choose a folder.'
      if (!workspaceFolderReady) return 'Choose a folder to continue.'
      if (!name.trim()) return 'Give the workspace a name.'
      return 'Press Continue to choose a mode.'
    case 'mode':
      return `Continue with ${labelFor(mode)}, or pick another.`
    case 'mcp-servers':
      return 'Pick tool integrations, or skip to add them later from Settings.'
    case 'skill-packs':
      return 'Pick skill packs, or skip to add them later from Settings.'
    case 'knowledge':
      return committedKnowledgeRoot
        ? `Knowledge folder: ${committedKnowledgeRoot} — continue, or change it.`
        : 'Pick a knowledge folder, or skip to set it later in Settings.'
    case 'standard-layout':
      return 'Pick a layout, then create.'
    case 'multiloop-goal':
      if (!mlGoal.trim()) return 'Describe the loop goal to create.'
      return 'Ready to create the loop.'
    case 'sprintengine-team':
      if (!sprintEngineAccess.allowed) return 'Sign in to run sprints.'
      if (sePath === 'plan' && !sePlanReady) return 'Select a backlog item or source file.'
      if (seExistingTeam) return 'Existing team loaded — continue.'
      if (!seTeamDetailsReady) {
        return sePath === 'plan' ? 'Add a team name.' : 'Add a team name and an objective.'
      }
      return 'Continue to the roster.'
    case 'sprintengine-roster':
      if (!sprintEngineAccess.allowed) return 'Sign in to run sprints.'
      if (seExistingTeam) return 'Ready to load team.'
      if (totalAgents === 0) return 'Add at least one specialist.'
      return 'Ready to create.'
    case 'guided-idea':
      if (!guidedIdea.trim()) return 'Describe the idea in a sentence or two.'
      if (guidedHasUi == null) return 'Pick whether the app has a screen.'
      if (!guidedSeedReady) {
        return guidedSeedMode === 'source-folder'
          ? 'Choose the folder to seed from.'
          : 'The brand demo is unavailable — pick another starting point.'
      }
      return 'Ready to capture the idea.'
  }
}
