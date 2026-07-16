import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { userLayoutTemplateToTemplate } from '../../layouts/userTemplates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost } from '../../modules'
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
  SprintEngineAllowedRuntime,
  SprintEngineAutoState,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineMockConfig,
  SprintEngineModelCatalogEntry,
  SprintEngineRoleId,
  SprintEngineRosterSource,
  SprintEngineRoleRegistry,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleModelOverrides,
  SprintEngineSourceBundleItem,
  SprintEngineSourceBundleKind,
  SprintEngineSourcePlanKind,
  SprintEngineState,
  SprintEngineSavedRoster,
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
import { CreationBackdrop } from '../backdrops/CreationBackdrop'
import { CliModelPickerButton, CloseIconButton, Field, GhostButton, Select, TruncatedText, WizardProgress } from '../ui'
import {
  analyzeWorkspaceTargetPath,
  defaultWorkspaceFolderPath,
  resolveDefaultParentPath,
} from './newWorkspace/folderCreation'
import { CreationRail } from './newWorkspace/CreationRail'
import { STANDARD_MODE_MODEL, buildModeModels } from './newWorkspace/modeModels'
import AgentComposer, {
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerProjectOption,
} from './agentComposer/AgentComposer'
import { RecentFolderRow, isSameFolder } from './newWorkspace/RecentFolderRow'
import { type SprintEngineCliOption } from './newWorkspace/SprintEngineRosterTable'
import { SprintEngineTeamPanel, type SprintEngineTeamMode } from './newWorkspace/SprintEngineTeamPanel'
import { SprintEngineReviewsPanel } from './newWorkspace/SprintEngineReviewsPanel'
import { SprintEngineToolsPanel } from './newWorkspace/SprintEngineToolsPanel'
import { SprintEngineStartPanel } from './newWorkspace/SprintEngineStartPanel'
import {
  buildSprintEngineWorkflowInitKeys,
  type SprintEngineReviewRuntime,
} from './newWorkspace/sprintengineWorkflowConfig'
import {
  listSprintEngineWizardSweepRoles,
  listSprintEngineWizardWorkRoles,
  sprintEngineRosterHasPlanningRole,
  sprintEngineRosterRoleFloor,
} from '../../utils/sprintengineRoleOptions'
import { mcpServerDisplayName } from '../../utils/mcpDisplayName'
import { useFolderHints, useFolderScan } from './newWorkspace/useNewWorkspaceFolder'
import { useBacklogScan } from './newWorkspace/useBacklogScan'
import { BacklogRowContent } from '../backlog/BacklogRow'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import type { BacklogItem, BacklogScanResult } from '../../utils/backlog'
import { compareBacklogItems } from '../../utils/backlogTriage'
import { childrenOfEpic, epicSlug } from '../../utils/backlogEpics'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { basename, folderKey, joinPath, planBasename, markdownTitle, shouldScanDirectory, slugifySiblingProjectId, toTitleName, inferSourcePlanKind, workspaceRelativePath } from './newWorkspace/helpers'
import { parentPath, samePath } from '../../utils/paths'
import { DEFAULT_SPRINTENGINE_TASK_REPO } from '../../../../shared/sprintengine/run-types'
import type { CreationMode, ExistingTeam, GuidedBriefHasUi, SprintEnginePath, UnreadableTeam } from './newWorkspace/types'
import { stepsForMode, type StepId } from './newWorkspace/creationStepFlows'
import {
  isLastStepIn,
  jumpTargetFor,
  nextStepFrom,
  previousStepFrom,
  shouldShowSkipToCreate,
  stepIndexIn,
  stepWithinFlow,
} from './newWorkspace/stepNavigation'
import { KnowledgeStep } from './newWorkspace/KnowledgeStep'
import { shouldShowKnowledgeStep } from './newWorkspace/knowledgeFolders'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import { CliPermissionPresetRow, PathRadio, type WizardSiblingProject } from './newWorkspace/WizardControls'
import { ArchitectTeamCard } from './newWorkspace/ArchitectTeamCard'
import { DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS, DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, pruneSprintEngineRoleCliDefaults, pruneSprintEngineRoleModelOverrides, resolveInitialSprintEngineRoster, sprintEngineRosterMatchesTeam, sprintEngineRosterStaffsSpecialists } from './newWorkspace/savedTeams'
import {
  resolveAvailableAgentCli,
  selectAgentCliCatalog,
  type AgentCliCatalogOption,
} from './newWorkspace/cliRuntimeOptions'
import { getAvailableModelCatalogEntries, modelCatalogEntryKey } from '../../utils/modelCatalog'
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
  buildModuleTypeCreation,
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

// The shell-owned mode models (chat, standard) and the rail ordering live in
// newWorkspace/modeModels.ts, shared with the CreationRail contract test.

const STEP_HEADING: Record<StepId, { title: string; subtitle: string }> = {
  workspace: {
    title: 'Name your workspace',
    subtitle: 'Give it a name and pick the folder it lives in.',
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
    title: 'Team',
    subtitle: 'Who plans and builds this sprint.',
  },
  'sprintengine-reviews': {
    title: 'Reviews',
    subtitle: 'What gets checked before the sprint finishes.',
  },
  'sprintengine-tools': {
    title: 'Tools & skills',
    subtitle: 'Optional. Selected tools are added to this project — manage them anytime in Settings.',
  },
  'sprintengine-start': {
    title: 'Review & start',
    subtitle: 'The sprint runs with everything below. Change any line before starting.',
  },
  'guided-idea': {
    title: 'Tell us about your idea',
    subtitle: 'A sentence or two, in plain words. We’ll ask the rest.',
  },
}

// Short station names for the labeled progress header (MC-1646): the sprint
// flow reads Where · What · Team · Reviews · Tools · Start instead of
// anonymous dashes. Other flows keep the dash strip and label back-jumps with
// the full STEP_HEADING title.
const STEP_LABEL: Record<StepId, string> = {
  workspace: 'Where',
  'mcp-servers': 'Tools',
  'skill-packs': 'Skills',
  knowledge: 'Knowledge',
  'standard-layout': 'Layout',
  'multiloop-goal': 'What',
  'sprintengine-team': 'What',
  'sprintengine-roster': 'Team',
  'sprintengine-reviews': 'Reviews',
  'sprintengine-tools': 'Tools',
  'sprintengine-start': 'Start',
  'guided-idea': 'What',
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

// Default first-run team + CLI map moved to newWorkspace/savedTeams.ts so the
// automation server's sprint.create seeds the identical roster; these aliases
// keep the wizard's local vocabulary.
const initialSprintEngineRoleCounts = DEFAULT_SPRINT_ENGINE_ROLE_COUNTS
const initialSprintEngineRoleCliDefaults = DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS

// The plain-agents create/spawn roster (MC-1585): a single `general` planner
// seat. Module-level so its reference is stable across renders — the effective
// roster derivations below hand it to memoized consumers (seInitialSpawnRoles).
const PLAIN_AGENT_ROLE_COUNTS: SprintEngineRoleCounts = { general: 1 }

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
  // MC-1585: the roster step opens on plain agents. It opens pre-expanded on the
  // specialist affordances only when a SAVED source (a selected team or the
  // legacy roster) staffs specialists — a fresh install (the built-in default
  // team) and a plain general-only saved team both open collapsed. Computed once
  // for the initial state; the toggle owns it afterwards.
  const initialUseSpecialistRoles =
    (Boolean(initialSprintEngineRoster.selectedTeamId) || Boolean(savedSprintEngineRoster))
    && sprintEngineRosterStaffsSpecialists(initialSprintEngineRoster.roleCounts)

  const initialFuturePlan = initialState?.futurePlanSource ?? null
  const initialMode: CreationMode =
    initialState?.mode ?? (initialFuturePlan ? 'sprintengine' : 'standard')
  const initialFolderPath = initialState?.folderPath ?? initialFuturePlan?.folderPath ?? null
  // The hub always shows the name field (the step wizard skipped it for
  // future-plan intake), so a pre-seeded folder — future-plan included — seeds
  // a workable default name instead of blocking create on an empty field.
  const initialWorkspaceName = initialFolderPath
    ? basename(initialFolderPath) || 'workspace'
    : ''

  const [mode, setMode] = useState<CreationMode>(initialMode)
  const [folderPath, setFolderPath] = useState<string | null>(initialFolderPath)
  // Unified folder field: a single editable full path that is created on
  // continue if it doesn't exist, or opened if it does. `folderPathPinned`
  // freezes name→path derivation once the user edits the path or browses.
  const [folderDraftPath, setFolderDraftPath] = useState<string>(initialFolderPath ?? '')
  // Mirror of folderDraftPath for async adopters (field blur) that must check
  // the field's CURRENT value at resolve time, not their closure's copy.
  const folderDraftPathRef = useRef(initialFolderPath ?? '')
  folderDraftPathRef.current = folderDraftPath
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
  // Automation defaults to the product default (run agents + approve eligible
  // artifacts), so an untouched or skipped run continues on its own. Manual
  // stays one click away on the run page.
  const [seStartRunner, setSeStartRunner] = useState(true)
  const [seUseWorktrees, setSeUseWorktrees] = useState(false)
  // "Also changes these projects" (MC-1613): the sibling projects found next to the
  // chosen folder, and the ids the user picked out of them (none by default). The
  // set is fixed at creation, so this is creation-time intent only — an existing
  // team keeps whatever it was created with and the control is read-only.
  const [seSiblingProjects, setSeSiblingProjects] = useState<WizardSiblingProject[]>([])
  const [seRepoIds, setSeRepoIds] = useState<string[]>([])
  // A run can only span projects when each one gets its own worktree — the engine
  // refuses the pair — so leaving worktree mode drops the extra projects with it
  // instead of holding a selection that would fail at creation.
  const handleChangeUseWorktrees = useCallback((value: boolean) => {
    setSeUseWorktrees(value)
    if (!value) setSeRepoIds([])
  }, [])
  const handleToggleProject = useCallback((id: string, on: boolean) => {
    setSeRepoIds((current) =>
      on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id),
    )
  }, [])
  // What creation actually declares: the picked projects resolved back to the
  // `{id, root}` the engine takes. Reading through the offered list means a project
  // that vanished from disk between the scan and Create cannot be declared, and a
  // selection stranded by worktree mode going off can never be sent.
  const seDeclaredRepos = useMemo(
    () =>
      seUseWorktrees
        ? seSiblingProjects
            .filter((project) => seRepoIds.includes(project.id))
            .map((project) => ({ id: project.id, root: project.root }))
        : [],
    [seUseWorktrees, seSiblingProjects, seRepoIds],
  )
  // Workspace-level concurrent-session cap (MC-1450: replaces the roster-size
  // ceiling). Clamped 1-10 at the input and again by the controller. Plain-agents
  // runs default to 2 ("two agents claiming from one task graph", MC-1585);
  // specialist runs keep the established default of 3.
  const [seMaxParallelAgents, setSeMaxParallelAgents] = useState(() => (initialUseSpecialistRoles ? 3 : 2))
  const [sePlanError, setSePlanError] = useState<string | null>(null)
  const [cliPermissionPreset, setCliPermissionPreset] = useState<SprintEngineCliPermissionPreset>(
    lastSpawnPermissionPreset,
  )
  const [seAutoApproveArtifacts, setSeAutoApproveArtifacts] = useState(true)
  const [seAutomationTouched, setSeAutomationTouched] = useState(false)
  // Untouched, the mode follows the create path: new and plan-sourced runs get
  // the product default (run agents + approve eligible artifacts), while
  // loading an existing team defaults to manual so a paused sprint never
  // auto-resumes just by being reopened. An explicit choice on the run page
  // wins over both, and every create path reads this derived mode.
  const seAutomationMode: SprintEngineAutomationMode = seAutomationTouched
    ? seAutoApproveArtifacts
      ? 'run_agents_and_approve_artifacts'
      : seStartRunner
        ? 'run_agents'
        : 'manual'
    : seExistingTeam
      ? 'manual'
      : 'run_agents_and_approve_artifacts'
  const setSeAutomationMode = (mode: SprintEngineAutomationMode) => {
    setSeAutomationTouched(true)
    setSeStartRunner(mode !== 'manual')
    setSeAutoApproveArtifacts(mode === 'run_agents_and_approve_artifacts')
  }
  // "Architect picks the team" wizard state. rosterSource selects the mode; the
  // rest are architect-mode inputs. seArchitectSeat and seSprintModelSelection
  // stay null until the user edits them, so the effective values track the
  // catalog-derived defaults (highest-Intelligence seat, offered-by-default ticks)
  // with no reseed race when the catalog/CLI availability loads. Guidance is
  // prompt-only (never persisted by the engine).
  const [seRosterSource, setSeRosterSource] = useState<SprintEngineRosterSource>('user')
  // Specialist roles on/off (MC-1585). Off = plain agents (a pool of general
  // agents sized by the concurrency cap). On = the specialist roster,
  // architect-picks-the-team mode, and Final sweeps. Driven by the Team page's
  // segmented control (MC-1646) through seTeamMode below.
  const [seUseSpecialistRoles, setSeUseSpecialistRoles] = useState(initialUseSpecialistRoles)
  // The Team page's segmented control (MC-1646) is a projection of the two
  // stored axes: specialist roles on/off (MC-1585) and who staffs the roster
  // (user vs architect). 'pool' leaves the last rosterSource intact so
  // switching back to a specialist segment restores the previous choice.
  const seTeamMode: SprintEngineTeamMode = !seUseSpecialistRoles
    ? 'pool'
    : seRosterSource === 'architect'
      ? 'architect'
      : 'roles'
  const setSeTeamMode = (mode: SprintEngineTeamMode) => {
    if (mode === 'pool') {
      setSeUseSpecialistRoles(false)
      return
    }
    setSeUseSpecialistRoles(true)
    setSeRosterSource(mode === 'architect' ? 'architect' : 'user')
  }
  const [seArchitectSeat, setSeArchitectSeat] = useState<SprintEngineAllowedRuntime | null>(null)
  const [seSprintModelSelection, setSeSprintModelSelection] = useState<ReadonlySet<string> | null>(null)
  const [seArchitectGuidance, setSeArchitectGuidance] = useState('')
  // "Workflow steps" + "Final sweeps" panels (MC-1542 / MC-1543). Defaults
  // match the engine defaults, so an untouched run omits all three init keys:
  // self-review ON (defaultPhases absent), reviewer = same agent (no
  // phaseRuntimes), no mandated sweeps (requiredSweeps absent).
  const [seSelfReviewEnabled, setSeSelfReviewEnabled] = useState(true)
  const [seReviewRuntime, setSeReviewRuntime] = useState<SprintEngineReviewRuntime | null>(null)
  const [seRequiredSweeps, setSeRequiredSweeps] = useState<ReadonlySet<SprintEngineRoleId>>(
    () => new Set<SprintEngineRoleId>(),
  )
  const toggleSprintEngineRequiredSweep = (role: SprintEngineRoleId, next: boolean) => {
    setSeRequiredSweeps((prev) => {
      const updated = new Set(prev)
      if (next) updated.add(role)
      else updated.delete(role)
      return updated
    })
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
  // Global model catalog (facts about models, entered once in Settings). The
  // architect-roster mode reads it for the per-sprint model selection and the
  // architect-seat default; user mode ignores it entirely.
  const sprintEngineModelCatalog = useWorkspaceStore((s) => s.appSettings.sprintEngineModelCatalog)
  // Available catalog entries: gated to installed CLIs, but only once detection is
  // trustworthy (ready + a non-empty installed set) — otherwise fall back to the
  // raw catalog so a still-loading probe never hides every model (mirrors the CLI
  // picker's availability fallback).
  const availableCatalogEntries = useMemo<SprintEngineModelCatalogEntry[]>(() => {
    if (cliAvailabilityStatus !== 'ready') return sprintEngineModelCatalog
    const installed = Object.values(cliAvailability).filter((entry) => entry.installed).map((entry) => entry.cli)
    if (installed.length === 0) return sprintEngineModelCatalog
    return getAvailableModelCatalogEntries({ sprintEngineModelCatalog }, installed)
  }, [sprintEngineModelCatalog, cliAvailability, cliAvailabilityStatus])
  const architectModeAvailable = availableCatalogEntries.length > 0
  const architectModeDisabledHint = sprintEngineModelCatalog.length === 0
    ? 'Add at least one model to your catalog in Settings'
    : 'No catalog model’s CLI is installed'
  // Architect seat defaults to the highest-Intelligence available entry, else the
  // plain wizard CLI default. Independent of the ticked selection by design (pin
  // a model here and leave it unticked = "runs the architect and nowhere else").
  const defaultArchitectSeat = useMemo<SprintEngineAllowedRuntime>(() => {
    const best = availableCatalogEntries.reduce<SprintEngineModelCatalogEntry | null>(
      (top, entry) => (!top || entry.intelligence > top.intelligence ? entry : top),
      null,
    )
    if (best) return { cli: best.cli, model: best.model }
    return { cli: resolveAvailableAgentCli('claude-code', sprintEngineCliOptions, 'claude-code'), model: null }
  }, [availableCatalogEntries, sprintEngineCliOptions])
  const seatDefaultedFromCatalog = availableCatalogEntries.length > 0 && seArchitectSeat === null
  const effectiveArchitectSeat = seArchitectSeat ?? defaultArchitectSeat
  // "CLI · model" crumb for the Review & start summary's architect line.
  const architectSeatLabel = useMemo(() => {
    const option = sprintEngineCliOptions.find((candidate) => candidate.value === effectiveArchitectSeat.cli)
    const cliLabel = option?.label ?? effectiveArchitectSeat.cli
    if (!effectiveArchitectSeat.model) return cliLabel
    const modelLabel =
      option?.modelSelection?.options.find((entry) => entry.id === effectiveArchitectSeat.model)?.label
      ?? effectiveArchitectSeat.model
    return `${cliLabel} · ${modelLabel}`
  }, [sprintEngineCliOptions, effectiveArchitectSeat])
  // Default ticks = offered-by-default available entries; the user's toggles
  // (seSprintModelSelection) override once they touch anything.
  const defaultSelectionKeys = useMemo<ReadonlySet<string>>(
    () => new Set(
      availableCatalogEntries
        .filter((entry) => entry.offeredByDefault)
        .map((entry) => modelCatalogEntryKey(entry.cli, entry.model)),
    ),
    [availableCatalogEntries],
  )
  const effectiveSelectionKeys = seSprintModelSelection ?? defaultSelectionKeys
  const selectedAllowedRuntimes = useMemo<SprintEngineAllowedRuntime[]>(
    () => availableCatalogEntries
      .filter((entry) => effectiveSelectionKeys.has(modelCatalogEntryKey(entry.cli, entry.model)))
      .map((entry) => ({ cli: entry.cli, model: entry.model })),
    [availableCatalogEntries, effectiveSelectionKeys],
  )
  // Architect mode is ready to create only with the option available AND at least
  // one ticked model — creation is never guessed from an empty selection.
  const architectModeReady = architectModeAvailable && selectedAllowedRuntimes.length > 0
  const toggleSprintModel = (entry: SprintEngineAllowedRuntime) => {
    const key = modelCatalogEntryKey(entry.cli, entry.model)
    const base = seSprintModelSelection ?? defaultSelectionKeys
    const next = new Set(base)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSeSprintModelSelection(next)
  }
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
  // The "Final sweeps" toggles ARE the roster contract for sweep roles: only
  // the sweeps the user turns ON ride into enabledRoles -> configuredRoles at
  // create (and into requiredSweeps as the completion mandate), so the roster
  // and the architect's plan reflect exactly what the user configured. MC-1545
  // originally force-enabled every registry sweep role here so "the architect
  // can decide" — which seated the full audit catalog (security, performance,
  // production-readiness…) on runs whose operator selected none of them, and
  // the architect then dutifully planned one sweep task per seated role (the
  // design-wizard-premium regression). If the work needs an unconfigured role,
  // the architect raises needs_input instead of adding it (agentPrompt.ts).
  const sprintEngineSweepEnabledRoles = useMemo<SprintEngineRoleId[]>(
    () =>
      listSprintEngineWizardSweepRoles(seRoleRegistry, effectiveSprintEngineDisabledRoleIds).filter(
        (role) => seRequiredSweeps.has(role),
      ),
    [seRoleRegistry, effectiveSprintEngineDisabledRoleIds, seRequiredSweeps],
  )
  // Role counts handed to CREATION (not the panel view): only roles the wizard
  // actually offers as "Work types & models" rows. seRoleCounts can carry stale
  // extras from a saved team — sweep roles (seats pre-MC-1542, toggles now) and
  // role ids the current registry doesn't know (e.g. the v1-era spec_reviewer)
  // — which would silently ride into configuredRoles as phantom, unseatable
  // roster rows the user never chose. Existing teams never re-create, so their
  // canonical counts pass through untouched.
  const sprintEngineCreateRoleCounts = useMemo<SprintEngineRoleCounts>(() => {
    if (seExistingTeam) return visibleSprintEngineRoleCounts
    const offered = new Set<SprintEngineRoleId>(
      listSprintEngineWizardWorkRoles(seRoleRegistry, effectiveSprintEngineDisabledRoleIds),
    )
    const filtered: SprintEngineRoleCounts = {}
    for (const [role, count] of Object.entries(visibleSprintEngineRoleCounts)) {
      if (offered.has(role as SprintEngineRoleId)) filtered[role as SprintEngineRoleId] = count
    }
    return filtered
  }, [seExistingTeam, visibleSprintEngineRoleCounts, seRoleRegistry, effectiveSprintEngineDisabledRoleIds])

  // MC-1585: the plain-agents default is a general-only run. seRoleCounts still
  // holds the specialist roster behind the collapsed disclosure (so toggling it
  // on restores those rows), so creation must NOT read it in plain mode — it
  // stages exactly one `general` planner seat, and the pool grows by
  // mint-on-demand up to the concurrency cap. Never applies to an existing team
  // (its canonical roster is fixed and the disclosure is not offered).
  const sprintEnginePlainAgents = !seExistingTeam && !seUseSpecialistRoles
  const sprintEngineEffectiveCreateRoleCounts = sprintEnginePlainAgents
    ? PLAIN_AGENT_ROLE_COUNTS
    : sprintEngineCreateRoleCounts
  // Spawn-at-start follows the planner (general here, architect in specialist
  // mode), so the launch bootstrap reads the effective counts, not the hidden
  // specialist roster. Final sweeps are a specialist affordance: plain runs mandate none.
  const sprintEngineEffectiveVisibleRoleCounts = sprintEnginePlainAgents
    ? PLAIN_AGENT_ROLE_COUNTS
    : visibleSprintEngineRoleCounts
  const sprintEngineEffectiveSweepEnabledRoles = sprintEnginePlainAgents ? [] : sprintEngineSweepEnabledRoles
  const sprintEngineEffectiveRequiredSweeps = sprintEnginePlainAgents
    ? []
    : ([...seRequiredSweeps] as SprintEngineRoleId[])

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

  // The projects sitting next to the chosen one: sibling directories that are git
  // repositories in their own right. That is exactly what a run may also change —
  // the engine takes whole, separate repositories only, and refuses anything inside
  // this project — so a candidate that fails those rules is never offered rather
  // than failing at creation. A folder with no such neighbours offers nothing and
  // the control stays hidden.
  useEffect(() => {
    let cancelled = false
    setSeSiblingProjects([])
    setSeRepoIds([])
    const parent = folderPath ? parentPath(folderPath) : null
    if (!folderPath || !parent || samePath(parent, folderPath)) return undefined
    void (async () => {
      try {
        const entries = await window.api.readdir(parent)
        if (cancelled) return
        const candidates = entries.filter(
          (entry) => entry.isDir && !entry.name.startsWith('.') && shouldScanDirectory(entry.name),
        )
        const found: WizardSiblingProject[] = []
        const usedIds = new Set<string>()
        for (const entry of candidates) {
          const root = joinPath(parent, entry.name)
          if (samePath(root, folderPath)) continue
          if (!(await window.api.pathExists(joinPath(root, '.git')).catch(() => false))) continue
          if (cancelled) return
          // The id is the handle tasks target and must be usable, unique, and never
          // the reserved name for this project itself. Derive it from the folder
          // name — the thing the user just read — and disambiguate rather than drop
          // a real project whose slug happens to collide.
          const base = slugifySiblingProjectId(entry.name)
          if (!base) continue
          let id = base
          for (let suffix = 2; usedIds.has(id) || id === DEFAULT_SPRINTENGINE_TASK_REPO; suffix += 1) {
            id = `${base}-${suffix}`
          }
          usedIds.add(id)
          found.push({ id, root: `../${entry.name}`, name: entry.name })
        }
        if (!cancelled) setSeSiblingProjects(found)
      } catch {
        // No readable parent directory: offer nothing rather than guess.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folderPath])

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
  // Set once folder materialization succeeds; the effect below runs the create
  // on the NEXT render so handleCreate's closure reads the fresh folderPath. A
  // brand-new folder is created inside the primary action, and creating +
  // reading in one closure would hand every mode branch a stale null folder.
  const [pendingCreate, setPendingCreate] = useState(false)

  // The pane pages through its flow one step at a time. A dropped plan opens on
  // the sprint's team step: its folder arrives with the drop, so the name+folder
  // page has nothing left to ask.
  const [step, setStep] = useState<StepId>(initialFuturePlan ? 'sprintengine-team' : 'workspace')
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward')

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

  const steps = useMemo(() => {
    const base = stepsForMode(mode)
    const withKnowledge = knowledgeStepEligible ? base : base.filter((id) => id !== 'knowledge')
    // An existing team's review workflow is already initialized in its run
    // state, so the Reviews page would be an empty screen — it drops out of the
    // flow the moment a team is loaded (mirroring the knowledge step's
    // eligibility filter). Tools stay: project-level integrations still apply.
    return seExistingTeam ? withKnowledge.filter((id) => id !== 'sprintengine-reviews') : withKnowledge
  }, [mode, knowledgeStepEligible, seExistingTeam])
  // The hub pages a mode's flow: the name+folder fields ('workspace') first,
  // then each config step on its own page, in flow order.
  const configSteps = useMemo(
    () => steps.filter((id) => id !== 'workspace'),
    [steps],
  )
  const stepIndex = stepIndexIn(steps, step)
  const isLastStep = isLastStepIn(steps, step)
  const stepLabels = useMemo(
    () => steps.map((id) => (mode === 'sprintengine' ? STEP_LABEL[id] : STEP_HEADING[id].title)),
    [steps, mode],
  )
  // The optional Advanced setup disclosure rides the flow's final page, for any
  // flow with real config steps; the zero-config quick flows (chat, switchboard,
  // automations) defer that configuration to Settings, exactly as before. The
  // sprint flow is the exception (MC-1646): its Tools & skills page IS that
  // configuration, so the accordion would offer the same choices twice.
  const showAdvancedSetup = configSteps.length > 0 && isLastStep && mode !== 'sprintengine'

  // The rail's type list — shell-owned Chat + Workspace, then the enabled
  // registry-contributed types (see modeModels.ts for the ordering contract).
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const modeModels = useMemo(() => buildModeModels(moduleOverrides), [moduleOverrides])
  const currentModeModel = modeModels.find((model) => model.id === mode) ?? STANDARD_MODE_MODEL

  // If the selected mode's module is disabled while the hub is open, fall back
  // to the always-available Workspace pane instead of rendering a ghost type.
  useEffect(() => {
    if (!modeModels.some((model) => model.id === mode)) setMode('standard')
  }, [modeModels, mode])

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

  // Keep the current step inside the flow when the step list changes under it —
  // the knowledge step dropping out for an already-configured folder, or a rail
  // switch racing the mode-scoped reset in handleSelectMode.
  useEffect(() => {
    setStep((current) => stepWithinFlow(steps, current))
  }, [steps])

  // Move focus to the page heading and reset the pane scroll on every page turn
  // (and on a type change, which resets the flow to its first page).
  useEffect(() => {
    if (stepBodyRef.current) stepBodyRef.current.scrollTop = 0
    headingRef.current?.focus({ preventScroll: true })
  }, [mode, step])

  // Auto-focus the name input on every non-chat pane (the chat pane's focus
  // belongs to the embedded composer) — unless focus is inside the rail: a
  // keyboard user arrowing through the type list keeps roving focus there,
  // and stealing it into the input would end the navigation after one press.
  useEffect(() => {
    if (!isChat) {
      const id = window.setTimeout(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active.closest('[role="tablist"]')) return
        nameInputRef.current?.focus()
      }, 60)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [isChat, mode])

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
      // A plain agent pool always stages its one general planner seat, so the
      // Team page can never block create in pool mode.
      || !seUseSpecialistRoles
      || (seRosterSource === 'architect'
        // Architect mode: the roster is the model palette — ready with the option
        // available and at least one model ticked (the architect is always seated).
        ? architectModeReady
        : (totalAgents > 0 && sprintEngineRosterHasPlanningRole(visibleSprintEngineRoleCounts))))
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

  const stepReadiness = {
    workspaceStepReady,
    standardLayoutStepReady,
    multiloopGoalReady,
    sprintEngineTeamReady,
    sprintEngineRosterReady,
    guidedIdeaReady,
  }
  // Every non-chat create requires the name+folder fields plus the mode's own
  // config steps; the first unready one drives the footer's blocking hint.
  // Chat has no hub create path — the embedded composer owns its own CTA.
  const requiredStepIds: StepId[] = ['workspace', ...configSteps]
  const firstBlockedStepId = isChat
    ? null
    : requiredStepIds.find((id) => !isStepReady(id, stepReadiness)) ?? null
  const createReady = !isChat && firstBlockedStepId == null
  // Continue is gated on the page you are on; create is gated on the whole flow.
  const currentStepReady = !isChat && isStepReady(step, stepReadiness)

  // The hint explains whichever action the footer is actually offering. If this
  // page is incomplete it speaks for this page (why Continue is disabled).
  // Otherwise it names the first step that still blocks create — the reason the
  // skip affordance is absent — which may be a page ahead of the user or, after
  // an aborted create reset the folder, one behind. Only when nothing blocks
  // create does it fall back to this page, whose terminal copy ("Ready to
  // create.") is then true: skip-to-create is on screen. Without that fallback
  // order, a ready name+folder page would claim "Ready to create." on a flow
  // whose intent step is still unanswered.
  const hintStep = !currentStepReady ? step : firstBlockedStepId ?? step
  // The Tools page's footer hint states the live selection count (MC-1646):
  // enabled MCP servers plus selected skill packs.
  const selectedMcpServers = integrationsMcpCatalog.filter((server) =>
    Boolean(mcpSettings?.servers[server.id]?.enabled),
  )
  const toolsSelectedCount = selectedMcpServers.length + selectedSkillPackIds.size
  const blockingMessage = getStepBlockingMessage({
    step: hintStep,
    workspaceFolderReady: folderTargetUsable,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seTeamDetailsReady,
    totalAgents,
    seRosterSource,
    sePlainAgents: !seUseSpecialistRoles,
    toolsSelectedCount,
    architectModeAvailable,
    architectModeReady,
    architectModeDisabledHint,
    guidedIdea,
    guidedHasUi,
    guidedSeedMode,
    guidedSeedReady,
    committedKnowledgeRoot,
  })

  const handleSelectMode = (next: CreationMode) => {
    // A type switch during an in-flight create would hand the deferred
    // handleCreate a different mode than the one the user confirmed.
    if (isCreating || pendingCreate) return
    setMode(next)
    // Every flow starts at 'workspace' (see creationStepFlows): a rail switch
    // restarts the new type's flow rather than stranding the user on page 3 of
    // the old one.
    setStep('workspace')
    setDirection('forward')
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

  // The hub stays mounted while open, so a host preselect fired at an
  // already-open panel (the sidebar "+" menu, launcher Sprint entry) must sync
  // in as a rail selection — the useState initializer only reads the mount-time
  // value. Each opener builds a fresh initialState object, so identity is the
  // "a preselect happened" signal. Routed through handleSelectMode so the
  // name-seeding side effects and the in-flight-create guard apply.
  useEffect(() => {
    const nextMode = initialState?.mode
    if (nextMode && nextMode !== mode) handleSelectMode(nextMode)
    // Only a NEW initialState (a fresh open/preselect) may re-route the rail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState])

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
    // The hub picks the type first (the rail), so a folder hint never
    // auto-switches the selected pane out from under the user; the Recent rows
    // still surface sprint/multiloop hints on the folder itself.
  }

  // Unified folder field edits. Editing or browsing pins the path so the
  // name→path derivation stops overriding the user's choice.
  const handleChangeFolderDraftPath = (value: string) => {
    setFolderPathPinned(true)
    setFolderDraftPath(value)
    setFolderError(null)
  }

  // Adopt (materialize) an existing folder into `folderPath` so the
  // folder-scoped surfaces — sprint team/backlog scans, knowledge eligibility,
  // the chat composer's project — track the pick while the user is still
  // configuring the pane. Adoption happens only on DELIBERATE picks (Browse,
  // a Recent row, leaving the folder field), never while typing: a debounced
  // or prefix-matched materialization would silently retarget folderPath and
  // wipe mode-scoped selections mid-keystroke. Same-folder adoption is a
  // no-op, so selections only reset on a real folder switch.
  const adoptFolderDraft = (dir: string) => {
    setFolderPathPinned(true)
    setFolderDraftPath(dir)
    setFolderError(null)
    if (!(folderPath && isSameFolder(dir, folderPath))) handleSelectFolder(dir)
  }

  const pickFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    adoptFolderDraft(dir)
  }

  const handleSelectRecentFolder = (dir: string) => {
    // Recents were real folders when recorded; adopt optimistically — the
    // scans degrade gracefully if the folder has since vanished, and create
    // recreates it exactly as the old wizard's Continue did.
    adoptFolderDraft(dir)
  }

  // Leaving the folder field with a typed path that exists adopts it (a fresh
  // existence check, not the 250ms-debounced display flag — that flag can be
  // stale mid-edit). A still-nonexistent path stays a draft until create.
  const handleFolderDraftBlur = () => {
    const target = folderDraftPath.trim()
    if (!target) return
    if (folderPath && isSameFolder(target, folderPath)) return
    void window.api
      .pathExists(target)
      .then((exists) => {
        // Re-read the field via state at resolve time: adopt only if the user
        // hasn't kept typing since the blur.
        if (exists && folderDraftPathRef.current.trim() === target) {
          adoptFolderDraft(target)
        }
      })
      .catch(() => {})
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
      // Already materialized to this exact folder — don't re-run selection,
      // which would reset mode-scoped source state on the way into create.
      if (!(folderPath && isSameFolder(target, folderPath))) handleSelectFolder(target)
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
      visibleRoleCounts: sprintEngineEffectiveVisibleRoleCounts,
    })) as Array<[SprintEngineRoleId, boolean | undefined]>)
      .filter(([, spawn]) => spawn)
      .map(([role]) => role),
    [seAutomationMode, seExistingTeam, sprintEngineEffectiveVisibleRoleCounts],
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
                // Raw state, not the path-aware seAutomationMode: a guided
                // build never resumes an existing team, so a stale sprint-tab
                // team selection must not flip this to manual.
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
                // Raw state, not the path-aware seAutomationMode: a guided
                // build never resumes an existing team, so a stale sprint-tab
                // team selection must not flip this to manual.
                buildStartRunner: seStartRunner,
                buildAutoApproveArtifacts: seAutoApproveArtifacts,
              },
              {
                filesystem: guidedFilesystem,
                discovery: {
                  readdir: window.api.readdir,
                  pathExists: window.api.pathExists,
                  statPath: window.api.statPath,
                },
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
          startRunner: seAutomationMode !== 'manual',
          autoApproveArtifacts: seAutomationMode === 'run_agents_and_approve_artifacts',
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
              visibleRoleCounts: sprintEngineEffectiveCreateRoleCounts,
              maxParallelAgents: seMaxParallelAgents,
              roleCliDefaults: seRoleCliDefaults,
              roleModelOverrides: seRoleModelOverrides,
              initialSpawnRoles: seInitialSpawnRoles,
              // Only the sweeps the user turned ON in the "Final sweeps" panel
              // join configuredRoles — the roster is the user's configuration.
              // Plain-agents runs never mandate a sweep (the panel is hidden).
              additionalEnabledRoles: sprintEngineEffectiveSweepEnabledRoles,
              // "Workflow steps" + "Final sweeps" init keys — same contract as
              // the new-team path (each key present only when set), so a
              // mandated sweep actually reaches run.yaml `requiredSweeps` on
              // plan-sourced launches too.
              ...buildSprintEngineWorkflowInitKeys({
                selfReviewEnabled: seSelfReviewEnabled,
                reviewRuntime: seReviewRuntime,
                requiredSweepRoleIds: sprintEngineEffectiveRequiredSweeps,
              }),
              startRunner: seAutomationMode !== 'manual',
              autoApproveArtifacts: seAutomationMode === 'run_agents_and_approve_artifacts',
              useWorktrees: seUseWorktrees,
              ...(seDeclaredRepos.length > 0 ? { repos: seDeclaredRepos } : {}),
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
        // Architect mode seats only the architect; the controller pins its
        // runtime from the seat picker and forwards the ticked palette. The user
        // roster (roleCounts/model overrides) is bypassed — the architect grows
        // the team via roster.configure after the user approves the plan.
        // Architect-picks mode is a specialist affordance, so it only applies
        // when specialist roles are in use; a plain-agents run always stages the
        // `general` planner seat from the effective counts.
        const architectMode = seUseSpecialistRoles && seRosterSource === 'architect'
        const createRoleCounts: SprintEngineRoleCounts = architectMode
          ? { architect: 1 }
          : sprintEngineEffectiveCreateRoleCounts
        const args = await runSprintEngineNewTeamCreation(
          {
            folderPath,
            teamName: sprintEngineConfig.name,
            goal: sprintEngineConfig.goal,
            roleCounts: createRoleCounts,
            visibleRoleCounts: createRoleCounts,
            maxParallelAgents: seMaxParallelAgents,
            roleCliDefaults: seRoleCliDefaults,
            roleModelOverrides: seRoleModelOverrides,
            initialSpawnRoles: architectMode ? ['architect'] : seInitialSpawnRoles,
            // Only the sweeps the user turned ON in the "Final sweeps" panel
            // join configuredRoles (ignored in architect mode) — the roster is
            // the user's configuration. Plain-agents runs mandate none.
            additionalEnabledRoles: sprintEngineEffectiveSweepEnabledRoles,
            startRunner: seAutomationMode !== 'manual',
            autoApproveArtifacts: seAutomationMode === 'run_agents_and_approve_artifacts',
            useWorktrees: seUseWorktrees,
            ...(seDeclaredRepos.length > 0 ? { repos: seDeclaredRepos } : {}),
            cliPermissionPreset,
            rosterSource: architectMode ? 'architect' : 'user',
            // "Workflow steps" + "Final sweeps" panels. Each key is present only
            // when it diverges from the engine default, so a plain run sends none.
            ...buildSprintEngineWorkflowInitKeys({
              selfReviewEnabled: seSelfReviewEnabled,
              reviewRuntime: seReviewRuntime,
              requiredSweepRoleIds: sprintEngineEffectiveRequiredSweeps,
            }),
            ...(architectMode
              ? {
                architectSeat: effectiveArchitectSeat,
                allowedRuntimes: selectedAllowedRuntimes,
                architectGuidance: seArchitectGuidance.trim() || undefined,
              }
              : {}),
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

    // Module-contributed workspace types (no shell branch above): the
    // registered definition's createTemplate() is the layout; the flow showed
    // no layout picker (see stepsForMode), so nothing here overrides it.
    if (mode !== 'standard' && getRendererHost().getWorkspaceType(mode)) {
      if (!folderPath) return
      const args = buildModuleTypeCreation({ mode, name, folderPath })
      setIsCreating(true)
      try {
        if (await persistAdvancedSetup(folderPath)) return
        onCreate(args)
        onClose()
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

  // The hub's single primary action: materialize the folder field
  // (create-if-missing / open-if-exists), then run the mode's create on the
  // next render (see pendingCreate above).
  const handlePrimaryAction = () => {
    if (isChat || isCreating || pendingCreate || !createReady) return
    void (async () => {
      setIsCreating(true)
      try {
        if (!(await materializeWorkspaceFolder())) return
      } finally {
        setIsCreating(false)
      }
      setPendingCreate(true)
    })()
  }

  useEffect(() => {
    if (!pendingCreate) return
    // Materializing a NEW folder re-runs handleSelectFolder, which resets
    // mode-scoped source state (a plan/team picked for the previous folder is
    // not valid for the new one). createReady here is from the post-reset
    // render, so a create invalidated by that reset aborts visibly — the
    // footer's blocking hint explains what to re-pick — instead of silently
    // creating something the user didn't configure.
    if (!createReady || isChat) {
      setPendingCreate(false)
      return
    }
    // pendingCreate stays true (button disabled, rail locked) until the whole
    // create settles: several create branches await network/IPC work before
    // they set isCreating themselves, and a re-enabled button in that gap
    // creates duplicates.
    void handleCreate().finally(() => setPendingCreate(false))
    // handleCreate/createReady are re-created per render; this effect fires
    // only on the pendingCreate flip, with the freshest closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreate])

  // Page turns are pure navigation: no IPC, nothing to await, nothing to fail.
  // The folder is materialized by handlePrimaryAction (see above), which is why
  // Continue is instant and why "Skip the rest and create" — which IS the
  // primary action — inherits materialization for free.
  const stepFlow = { steps, step, busy: isCreating || pendingCreate }

  const goNext = () => {
    const target = nextStepFrom({ ...stepFlow, currentStepReady })
    if (!target) return
    setDirection('forward')
    setStep(target)
  }

  const goBack = () => {
    const target = previousStepFrom(stepFlow)
    if (!target) return
    setDirection('backward')
    setStep(target)
  }

  // Back-jump from the progress bar: only to an already-completed (earlier) page,
  // and never mid-create. The step-change effect handles focus + scroll reset.
  const jumpToStep = (index: number) => {
    const target = jumpTargetFor(stepFlow, index)
    if (!target) return
    setDirection('backward')
    setStep(target)
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
    if (isLastStep) handlePrimaryAction()
    else goNext()
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
      // Raw state (see the guided scaffold sites): guided builds never
      // involve an existing team.
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
    ? createLabelFor(mode, isCreating || pendingCreate, seExistingTeam != null)
    : 'Continue'
  // One skip control, not two: the flow's remaining pages are all defaulted the
  // moment createReady turns true, so from there the user can leave at any time.
  // A per-page Skip button as well would make people stop and read the footer.
  const showSkipToCreate = shouldShowSkipToCreate({ createReady, isLastStep })
  const stepHeading = STEP_HEADING[step]
  const stepAnimationClass =
    direction === 'forward' ? 'wizard-step-in-forward' : 'wizard-step-in-backward'
  // The sprint's source page (backlog picker, team cards) is the one wide page;
  // its rebuilt config pages are a single reading column of at most ~640px
  // (MC-1646), and every other page — including the sprint's own name+folder
  // page — keeps the 560px measure the shared fields read at.
  const wideStep = isSprintEngine && step === 'sprintengine-team'
  const stepColumnClass = wideStep
    ? ''
    : isSprintEngine && step !== 'workspace'
      ? 'max-w-[640px]'
      : 'max-w-[560px]'

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
      {/* The hub modal floats on the creation backdrop: the wallpaper stays
          visible around a fixed-size surface (the Settings-overlay shell
          contract). The rail is the type choice — never a step — and the pane
          beside it pages through that type's flow with a pinned primary action. */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
        <div className="flex h-full max-h-[min(820px,100%)] w-full max-w-[1040px] flex-col overflow-hidden rounded-[8px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)]">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <MulticodeMark className="h-[18px] w-[18px]" variant="mono" />
              <h2
                id="new-workspace-title"
                className="text-[13px] font-semibold text-[color:var(--text-strong)]"
              >
                New
              </h2>
            </div>
            {/* Chat has no steps (its composer owns the whole config), and a
                one-page flow has nothing to indicate. */}
            {!isChat && steps.length > 1 ? (
              <WizardProgress
                total={steps.length}
                active={stepIndex}
                currentStepLabel={stepHeading.title}
                stepLabels={stepLabels}
                onStepSelect={jumpToStep}
                // The sprint's six-page flow reads as named stations (MC-1646);
                // the short two/three-page flows keep the quiet dash strip.
                variant={isSprintEngine ? 'labeled' : 'dashes'}
              />
            ) : null}
            {allowClose ? (
              <CloseIconButton
                size="md"
                aria-label="Close"
                onClick={requestClose}
              />
            ) : null}
          </header>

          <div className="flex min-h-0 flex-1">
            <CreationRail models={modeModels} mode={mode} onSelect={handleSelectMode} />

            <div
              role="tabpanel"
              aria-labelledby={`creation-tab-${mode}`}
              className="flex min-w-0 flex-1 flex-col"
            >
              {isChat ? (
                <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
                  <header className="flex flex-col gap-1">
                    <h3
                      ref={headingRef}
                      tabIndex={-1}
                      className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
                    >
                      {currentModeModel.label}
                    </h3>
                    <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
                      {currentModeModel.description}
                    </p>
                  </header>
                  {/* Chat's config region: the same AgentComposer the standalone
                      New chat panel wraps. It carries its own project chip and
                      Start-chat action, so the hub renders no shared footer for
                      this pane. Confirm routes to the host's solo-chat create. */}
                  <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[color:var(--border-default)]">
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
                </div>
              ) : (
                <>
                  {/* Only the active page renders. The pane keeps overflow-y-auto
                      as a short-window safety net, not the normal path: a page
                      is meant to fit, with its primary action pinned below. */}
                  <main ref={stepBodyRef} className="relative min-h-0 flex-1 overflow-y-auto">
                    {/* Pages with a flexing region (the workspace page's Recent
                        list, the run page's columns) take the pane's exact
                        height so those regions absorb the leftover space and
                        the page itself never scrolls. */}
                    <div
                      key={step}
                      className={`flex w-full ${stepColumnClass} ${step === 'workspace' ? 'h-full' : ''} flex-col gap-7 px-6 py-5 ${stepAnimationClass}`}
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

                      {/* The first page introduces the type the rail selected, then
                          asks for the two things every type needs. */}
                      {step === 'workspace' ? (
                        <>
                          <header className="flex flex-col gap-1.5">
                            <h3
                              ref={headingRef}
                              tabIndex={-1}
                              className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
                            >
                              {currentModeModel.label}
                            </h3>
                            <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
                              {currentModeModel.description}
                            </p>
                          </header>

                          <WorkspaceStep
              name={name}
              onChangeName={handleChangeName}
              folderDraftPath={folderDraftPath}
              onChangeFolderDraftPath={handleChangeFolderDraftPath}
              onBlurFolderDraftPath={handleFolderDraftBlur}
              onBrowseFolder={() => void pickFolder()}
              folderDraftExists={folderDraftExists}
              folderError={folderError}
              onSelectRecent={handleSelectRecentFolder}
              recentFolders={recentFolders}
              folderHints={folderHints}
              // A hint matching the selected flow is decoration, not signal
              // (MC-1646): in the sprint flow every candidate folder would wear
              // the same gold "Sprint" pill. Hints for OTHER flows still show.
              suppressedHint={
                mode === 'sprintengine' ? 'sprintengine' : mode === 'multiloop' ? 'multiloop' : null
              }
              inputRef={nameInputRef}
            />
                        </>
                      ) : null}

          {step === 'standard-layout' ? (
            <ConfigStepSection stepId="standard-layout" headingRef={headingRef}>
            <StandardLayoutStep
              layoutId={layoutId}
              onChange={setLayoutId}
              userTemplates={userLayoutTemplates}
              onTemplatesChanged={loadUserLayoutTemplates}
            />
            </ConfigStepSection>
          ) : null}

          {step === 'multiloop-goal' ? (
            <ConfigStepSection stepId="multiloop-goal" headingRef={headingRef}>
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
            </ConfigStepSection>
          ) : null}

          {step === 'sprintengine-team' ? (
            <ConfigStepSection stepId="sprintengine-team" headingRef={headingRef}>
            <SprintEngineTeamStep
              access={sprintEngineAccess}
              onSignIn={() => void startLogin()}
              folderPath={folderPath}
              isScanning={folderScan.isScanning}
              existingTeams={folderScan.result.teams}
              unreadableTeams={folderScan.result.unreadableTeams}
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
            </ConfigStepSection>
          ) : null}

          {step === 'guided-idea' ? (
            <ConfigStepSection stepId="guided-idea" headingRef={headingRef}>
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
            </ConfigStepSection>
          ) : null}

          {/* The sprint's rebuilt config pages (MC-1646): Team, Reviews,
              Tools & skills, and Review & start — one reading column each. */}
          {step === 'sprintengine-roster' ? (
            <ConfigStepSection stepId="sprintengine-roster" headingRef={headingRef}>
            {!sprintEngineAccess.allowed ? (
              <SprintEngineAccessNotice access={sprintEngineAccess} onSignIn={() => void startLogin()} />
            ) : (
              <>
                {seExistingTeam != null ? (
                  <p className="rounded-md border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-3 py-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
                    Loading <span className="font-semibold">{seExistingTeam.displayName}</span> — team size is read-only; the agent for each role can still be changed before launch.
                  </p>
                ) : null}
                {sePlanError ? (
                  <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
                    {sePlanError}
                  </div>
                ) : null}
                <SprintEngineTeamPanel
                  teamMode={seExistingTeam != null ? 'roles' : seTeamMode}
                  // An existing team's formation is fixed, so the segmented
                  // control is withheld.
                  onChangeTeamMode={seExistingTeam != null ? undefined : setSeTeamMode}
                  architectModeAvailable={architectModeAvailable}
                  architectModeDisabledHint={architectModeDisabledHint}
                  roleCounts={visibleSprintEngineRoleCounts}
                  roleCliDefaults={seRoleCliDefaults}
                  roleModelOverrides={seRoleModelOverrides}
                  onSetRoleCount={setRoleCount}
                  onSetRoleCli={setRoleCli}
                  onSetRoleModel={setRoleModel}
                  cliOptions={sprintEngineCliOptions}
                  registry={seRoleRegistry}
                  registryStatus={seRoleRegistryStatus}
                  disabledRoleIds={effectiveSprintEngineDisabledRoleIds}
                  rosterDisabled={seExistingTeam != null}
                  hasExistingTeam={seExistingTeam != null}
                  teams={sprintEngineTeams}
                  selectedTeamId={seSelectedTeamId}
                  selectedTeamDirty={selectedSprintEngineTeamDirty}
                  onSelectTeam={handleSelectSprintEngineTeam}
                  onSaveTeam={handleSaveSprintEngineTeam}
                  onUpdateTeam={handleUpdateSprintEngineTeam}
                  onRenameTeam={handleRenameSprintEngineTeam}
                  onDeleteTeam={handleDeleteSprintEngineTeam}
                  poolAgentCount={seMaxParallelAgents}
                  onChangePoolAgentCount={setSeMaxParallelAgents}
                  architectCard={
                    <ArchitectTeamCard
                      seat={effectiveArchitectSeat}
                      seatDefaultedFromCatalog={seatDefaultedFromCatalog}
                      cliOptions={sprintEngineCliOptions}
                      onChangeSeat={setSeArchitectSeat}
                      availableEntries={availableCatalogEntries}
                      selectedKeys={effectiveSelectionKeys}
                      onToggleEntry={toggleSprintModel}
                      guidance={seArchitectGuidance}
                      onChangeGuidance={setSeArchitectGuidance}
                    />
                  }
                />
              </>
            )}
            </ConfigStepSection>
          ) : null}

          {step === 'sprintengine-reviews' ? (
            <ConfigStepSection stepId="sprintengine-reviews" headingRef={headingRef}>
            {!sprintEngineAccess.allowed ? (
              <SprintEngineAccessNotice access={sprintEngineAccess} onSignIn={() => void startLogin()} />
            ) : (
              <SprintEngineReviewsPanel
                cliOptions={sprintEngineCliOptions}
                registry={seRoleRegistry}
                disabledRoleIds={effectiveSprintEngineDisabledRoleIds}
                selfReviewEnabled={seSelfReviewEnabled}
                onChangeSelfReviewEnabled={setSeSelfReviewEnabled}
                reviewRuntime={seReviewRuntime}
                onChangeReviewRuntime={setSeReviewRuntime}
                requiredSweepRoleIds={seRequiredSweeps}
                onToggleRequiredSweep={toggleSprintEngineRequiredSweep}
                roleCliDefaults={seRoleCliDefaults}
                roleModelOverrides={seRoleModelOverrides}
                onSetRoleCli={setRoleCli}
                onSetRoleModel={setRoleModel}
                // Final sweeps are a specialist affordance (MC-1585): hidden
                // while the run is a plain agent pool.
                showFinalSweeps={seUseSpecialistRoles}
              />
            )}
            </ConfigStepSection>
          ) : null}

          {step === 'sprintengine-tools' ? (
            <ConfigStepSection stepId="sprintengine-tools" headingRef={headingRef}>
            {!sprintEngineAccess.allowed ? (
              <SprintEngineAccessNotice access={sprintEngineAccess} onSignIn={() => void startLogin()} />
            ) : (
              <SprintEngineToolsPanel
                mcpCatalog={integrationsMcpCatalog}
                mcpSettings={mcpSettings ?? null}
                onToggleMcp={toggleMcpInWizard}
                skillPackCatalog={integrationsSkillPackCatalog}
                selectedSkillPackIds={selectedSkillPackIds}
                onToggleSkillPack={toggleSkillPackInWizard}
                message={integrationsMessage}
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
            )}
            </ConfigStepSection>
          ) : null}

          {step === 'sprintengine-start' ? (
            <ConfigStepSection stepId="sprintengine-start" headingRef={headingRef}>
            {!sprintEngineAccess.allowed ? (
              <SprintEngineAccessNotice access={sprintEngineAccess} onSignIn={() => void startLogin()} />
            ) : (
              <SprintEngineStartPanel
                workspaceName={name}
                folderPath={folderPath}
                objective={seGoal.trim()}
                teamMode={seTeamMode}
                hasExistingTeam={seExistingTeam != null}
                existingTeamName={seExistingTeam?.displayName ?? null}
                roleCounts={visibleSprintEngineRoleCounts}
                registry={seRoleRegistry}
                disabledRoleIds={effectiveSprintEngineDisabledRoleIds}
                cliOptions={sprintEngineCliOptions}
                roleCliDefaults={seRoleCliDefaults}
                roleModelOverrides={seRoleModelOverrides}
                poolAgentCount={seMaxParallelAgents}
                architectSeatLabel={architectSeatLabel}
                showReviewsRow={seExistingTeam == null}
                selfReviewEnabled={seSelfReviewEnabled}
                reviewRuntime={seReviewRuntime}
                requiredSweepRoleIds={new Set(sprintEngineEffectiveRequiredSweeps)}
                selectedToolNames={selectedMcpServers.map(mcpServerDisplayName)}
                selectedSkillPackCount={selectedSkillPackIds.size}
                onEditStep={(target) => jumpToStep(steps.indexOf(target))}
                cliPermissionPreset={cliPermissionPreset}
                onChangeCliPermissionPreset={setCliPermissionPreset}
                automationMode={seAutomationMode}
                onChangeAutomationMode={setSeAutomationMode}
                maxParallelAgents={seMaxParallelAgents}
                onChangeMaxParallelAgents={setSeMaxParallelAgents}
                // In pool mode the Team page's stepper owns this value; showing
                // the same number twice would read as two controls.
                showMaxParallelAgents={seExistingTeam != null || seUseSpecialistRoles}
                useWorktrees={seUseWorktrees}
                onChangeUseWorktrees={handleChangeUseWorktrees}
                worktreesDisabled={seExistingTeam != null}
                projectOptions={seSiblingProjects}
                selectedProjectIds={seRepoIds}
                onToggleProject={handleToggleProject}
                projectsDisabled={seExistingTeam != null}
                createError={sePlanError}
              />
            )}
            </ConfigStepSection>
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
                    </div>
                  </main>

                  {/* Pinned footer: the page body scrolls above it, so the
                      primary action never leaves the viewport on a tall page
                      (the sprint roster, the guided idea, the loop goal). */}
                  <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] px-6 py-3">
                    <p className="min-w-0 flex-1 truncate text-[12px] leading-5 text-[color:var(--text-subtle)]">
                      {blockingMessage}
                    </p>
                    <div className="flex shrink-0 items-center gap-3">
                      {/* Everything left in the flow is already defaulted, so the
                          user can leave now and change the rest later. */}
                      {showSkipToCreate ? (
                        <button
                          type="button"
                          onClick={handlePrimaryAction}
                          disabled={isCreating || pendingCreate}
                          className="
                            inline-flex h-9 items-center rounded-md px-2 text-[12.5px] font-medium text-[color:var(--text-subtle)]
                            transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                            disabled:cursor-not-allowed disabled:text-[color:var(--text-disabled)] disabled:hover:bg-transparent
                            focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                          "
                        >
                          Skip the rest and create
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={isLastStep ? handlePrimaryAction : goNext}
                        disabled={
                          (isLastStep ? !createReady : !currentStepReady) || isCreating || pendingCreate
                        }
                        className="
                          inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--accent-primary)] px-4 text-[13px] font-semibold text-[color:var(--bg-app)]
                          transition-colors hover:bg-[color:var(--accent-primary-hover)]
                          disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
                          focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                        "
                      >
                        {primaryLabel}
                      </button>
                    </div>
                  </footer>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
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
  onBlurFolderDraftPath,
  onBrowseFolder,
  folderDraftExists,
  folderError,
  onSelectRecent,
  recentFolders,
  folderHints,
  suppressedHint,
  inputRef,
}: {
  name: string
  onChangeName: (value: string) => void
  folderDraftPath: string
  onChangeFolderDraftPath: (value: string) => void
  onBlurFolderDraftPath: () => void
  onBrowseFolder: () => void
  folderDraftExists: boolean | null
  folderError: string | null
  onSelectRecent: (path: string) => void
  recentFolders: string[]
  folderHints: ReturnType<typeof useFolderHints>
  /** Hint chip suppressed because it matches the selected flow (MC-1646). */
  suppressedHint: 'sprintengine' | 'multiloop' | null
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
            ? { tone: 'muted', text: 'New — this folder will be created.' }
            : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
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
            onBlur={onBlurFolderDraftPath}
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
        // The list takes exactly the space the page has left and scrolls
        // internally — the page itself never scrolls for recents. The floor
        // keeps a couple of rows usable on very short windows (where the
        // pane's own scroll is the safety net).
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">
            Recent
          </div>
          <div className="flex min-h-[88px] flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
            {recentFolders.map((recent) => {
              const hint = folderHints.get(recent)
              const hints: Array<'sprintengine' | 'multiloop'> = []
              if (hint?.hasSprintEngineTeam && suppressedHint !== 'sprintengine') hints.push('sprintengine')
              if (hint?.hasMultiloop && suppressedHint !== 'multiloop') hints.push('multiloop')
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

// One config step's page inside a hub pane. Its STEP_HEADING is the page's
// heading, at the same scale as the type heading on the first page, and it takes
// focus on the page turn (see the step-change effect).
function ConfigStepSection({
  stepId,
  headingRef,
  children,
}: {
  stepId: StepId
  headingRef?: React.Ref<HTMLHeadingElement>
  children: ReactNode
}) {
  const heading = STEP_HEADING[stepId]
  return (
    // flex-1/min-h-0 only bite when the page runs at h-full (see the page
    // container); on auto-height pages they are no-ops.
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-[17px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
        >
          {heading.title}
        </h3>
        <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">{heading.subtitle}</p>
      </header>
      {children}
    </section>
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
      {/* Two-up grid: six built-ins land in three ~76px rows (~240px), so the
          page fits the pane without scrolling instead of stacking ~650px of
          full-width cards. */}
      <div role="radiogroup" aria-label="IDE layout" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {LAYOUT_TEMPLATES.map((template) => (
          <LayoutTemplateRadio key={template.id} template={template} active={template.id === layoutId} onChange={onChange} />
        ))}
        {userTemplates.length > 0 ? (
          <>
            <div className="mt-2 text-[11px] font-medium text-[color:var(--text-subtle)] sm:col-span-2">Installed templates</div>
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
  unreadableTeams: UnreadableTeam[]
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
    unreadableTeams,
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
      {/* One row, not a ~270px stack: the source choice must leave the team
          name and objective — the flow's only required input — above the fold. */}
      <div
        role="radiogroup"
        aria-label="Sprint starting point"
        className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
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

      {/* A sprint the app found but refuses to open (today: a run store from an
          older Multicode). Dropping it from the picker with no message reads as a
          lost sprint, so it is named here with its remedy. */}
      {unreadableTeams.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[color:var(--tone-warn)] px-3 py-2">
          {unreadableTeams.map((team) => (
            <p key={team.slug} className="text-[11px] leading-4 text-[color:var(--text-muted)]">
              <span className="font-medium text-[color:var(--text-strong)]">{team.slug}</span> can’t be opened.{' '}
              {team.message}
            </p>
          ))}
        </div>
      ) : null}

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
      return 'A sprint with this name already exists.'
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
      return 'A sprint with this name already exists.'
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
      return 'A sprint with this name already exists.'
    case 'unknown':
      return error.message && error.message !== error.code
        ? error.message
        : 'Could not create the sprint workspace.'
  }
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
    // The reviews, tools, and review-&-start pages are refinement pages, not
    // intent ones: every control on them is already defaulted (self-review,
    // required sweeps, integrations, automation, permissions, parallelism,
    // worktrees), so none of them can ever block create. That is what keeps
    // "Skip the rest and create" honest from the roster page on (the
    // skip-to-create invariant in creationStepFlows).
    case 'sprintengine-reviews':
      return true
    case 'sprintengine-tools':
      return true
    case 'sprintengine-start':
      return true
    case 'guided-idea':
      return readiness.guidedIdeaReady
  }
}

function getStepBlockingMessage(args: {
  step: StepId
  workspaceFolderReady: boolean
  name: string
  mlGoal: string
  sprintEngineAccess: PremiumFeatureAccessState
  sePath: SprintEnginePath
  sePlanReady: boolean
  seExistingTeam: ExistingTeam | null
  seTeamDetailsReady: boolean
  totalAgents: number
  seRosterSource: SprintEngineRosterSource
  sePlainAgents: boolean
  toolsSelectedCount: number
  architectModeAvailable: boolean
  architectModeReady: boolean
  architectModeDisabledHint: string
  guidedIdea: string
  guidedHasUi: GuidedBriefHasUi | null
  guidedSeedMode: DesignSystemSeedMode
  guidedSeedReady: boolean
  committedKnowledgeRoot: string | null
}): string {
  const {
    step,
    workspaceFolderReady,
    name,
    mlGoal,
    sprintEngineAccess,
    sePath,
    sePlanReady,
    seExistingTeam,
    seTeamDetailsReady,
    totalAgents,
    seRosterSource,
    sePlainAgents,
    toolsSelectedCount,
    architectModeAvailable,
    architectModeReady,
    architectModeDisabledHint,
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
      return 'Ready to create.'
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
      // A plain agent pool always stages its general planner seat.
      if (sePlainAgents) return 'Ready to create.'
      if (seRosterSource === 'architect') {
        if (!architectModeAvailable) return architectModeDisabledHint
        if (!architectModeReady) return 'Tick at least one model for this sprint.'
        return 'Ready to create.'
      }
      if (totalAgents === 0) return 'Turn on at least one role.'
      return 'Ready to create.'
    case 'sprintengine-reviews':
      if (!sprintEngineAccess.allowed) return 'Sign in to run sprints.'
      return 'Ready to create.'
    // The tools page's hint reports the live selection instead of a readiness
    // gate — the page is optional and can never block create.
    case 'sprintengine-tools':
      if (!sprintEngineAccess.allowed) return 'Sign in to run sprints.'
      return toolsSelectedCount === 0
        ? 'No tools selected — the sprint runs without integrations.'
        : `${toolsSelectedCount} tool${toolsSelectedCount === 1 ? '' : 's'} selected.`
    // The review-&-start page is the sprint's last step, so its hint is the one
    // the footer shows next to the Start sprint action.
    case 'sprintengine-start':
      if (!sprintEngineAccess.allowed) return 'Sign in to run sprints.'
      if (seExistingTeam) return 'Ready to load team.'
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
