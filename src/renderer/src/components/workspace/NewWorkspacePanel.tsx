import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../store/slices/settingsSlice'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { userLayoutTemplateToTemplate } from '../../layouts/userTemplates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost } from '../../modules'
import { ModuleCreationStepSection } from './newWorkspace/ModuleCreationStepSection'
import { createGuidedBriefTemplate } from '../../modules/design-wizard-workspace-types'
import { createReviewTemplate } from '../../review/workspaceTypes'
import {
  AUTOMATIONS_HOST_WORKSPACE_MODE,
  REVIEW_WORKSPACE_MODE,
  SPRINT_ENGINE_WORKSPACE_MODE,
} from '../../types/workspace'
import type { GitBranchSnapshot, ReviewSourceInput } from '../../../../shared/electron-api'
import type {
  AgentCli,
  AgentId,
  DesignSystemSeedSource,
  LayoutTemplate,
  McpCatalogServer,
  ReviewGuideConfig,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceMode,
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
  getSprintEngineRoleLabel,
  getUserDisabledSprintEngineRoleIds,
  sprintEngineRoleOrder,
} from '../../utils/sprintengine'
import MulticodeMark from '../brand/MulticodeMark'
import { CreationBackdrop } from '../backdrops/CreationBackdrop'
import { CliModelPickerButton, CloseIconButton, Field, FOCUS_RING_CLASS, GhostButton, TruncatedText, WizardProgress } from '../ui'
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
import { basename, folderKey, toTitleName } from './newWorkspace/helpers'
import type { CreationMode, GuidedBriefHasUi } from './newWorkspace/types'
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
import { ReviewSourceStep, type ReviewProbeState } from './newWorkspace/ReviewSourceStep'
import { shouldShowKnowledgeStep } from './newWorkspace/knowledgeFolders'
import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import { DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS } from './newWorkspace/savedRosters'
import {
  resolveAvailableAgentCli,
  selectAgentCliCatalog,
} from './newWorkspace/cliRuntimeOptions'
import { remapRoleCliDefaultsToAvailable, useRosterEditor } from './newWorkspace/useRosterEditor'
import {
  DesignSystemScaffoldError,
  GuidedBriefScaffoldError,
  GuidedBriefStartBuildError,
  buildAutomationsCreation,
  buildModuleTypeCreation,
  buildStandardCreation,
  buildSwitchboardCreation,
  runReviewCreation,
  ReviewControllerError,
  runDesignSystemScaffold,
  runGuidedBriefScaffold,
  runGuidedBriefStartBuild,
} from './newWorkspace/controllers'

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
  knowledge: {
    title: 'Connect a knowledge graph',
    subtitle: 'Point new agents at a folder of project knowledge they should read. Optional — skip and set it later in Settings.',
  },
  'guided-idea': {
    title: 'Tell us about your idea',
    subtitle: 'A sentence or two, in plain words. We’ll ask the rest.',
  },
  'review-source': {
    title: 'What are you reviewing?',
    subtitle: 'Point this workspace at one set of changes — a pull request, a branch, or a pasted patch.',
  },
  // Placeholder only — a module step renders its own registered heading via
  // ModuleCreationStepSection, and stepHeading/stepLabels substitute it too.
  'module-step': {
    title: 'Configure',
    subtitle: '',
  },
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

const initialGuidedBriefRoleCliDefaults: GuidedBriefRoleCliDefaults = {
  product: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS.product ?? 'claude-code',
  architect: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS.architect ?? 'claude-code',
  frontend: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS.frontend ?? 'claude-code',
}

export type NewWorkspacePanelInitialState = {
  mode?: CreationMode
  folderPath?: string | null
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
  /** Sprint creation left the wizard (MC-2062): the rail's Sprint row hands
   *  off to the New sprint dialog instead of entering a wizard flow. The host
   *  dismisses this panel as part of opening the dialog. */
  onOpenNewSprintDialog: (folderPath: string | null) => void
}

export default function NewWorkspacePanel({
  onCreate,
  onClose,
  workspaceWindowId,
  allowClose = true,
  initialState = null,
  chatComposer,
  onOpenNewSprintDialog,
}: Props) {
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const storedRecentFolders = useWorkspaceStore(
    (s) => s.appSettings.recentWorkspaceFolders ?? [],
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots)
  const setProjectKnowledgeRoot = useWorkspaceStore((s) => s.setProjectKnowledgeRoot)
  const lastSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset,
  )
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)

  // Sprint creation is the New sprint dialog (MC-2062), never a hub flow: a
  // sprint preselect must not mount a sprint pane. The initialState sync effect
  // below routes it through handleSelectMode, whose sprint branch hands off to
  // the dialog, so the hub itself opens on the standard pane.
  const requestedInitialMode = initialState?.mode ?? 'standard'
  const initialMode: CreationMode =
    requestedInitialMode === SPRINT_ENGINE_WORKSPACE_MODE ? 'standard' : requestedInitialMode
  const initialFolderPath = initialState?.folderPath ?? null
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
  // Index 2 is Solo Dev — explorer + editor + one agent terminal. Every standard
  // workspace starts there: the creation flow no longer has a layout step, and a
  // different layout comes from the Command Palette once the workspace exists.
  const [layoutId] = useState<string>(
    LAYOUT_TEMPLATES[2]?.id ?? LAYOUT_TEMPLATES[0].id,
  )
  // Still loaded and still handed to buildStandardCreation, which resolves a
  // layoutId against bundled + user templates. With the layout step gone nothing
  // in the UI selects a user template today; the plumbing stays so a future
  // surface for them plugs straight in rather than being rebuilt.
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

  // Spawn-permission preset carried into the Guided Brief scaffold (the sprint
  // wizard that used to edit it is gone — MC-2062); the value is the stored
  // preference, and the guided handoff surface owns any per-run change.
  const [cliPermissionPreset] = useState<SprintEngineCliPermissionPreset>(
    lastSpawnPermissionPreset,
  )

  // Review workspace creation state (MC-1677). The source segment leads with
  // Pull request (per the accepted mockup); the GitHub provider (MC-1678) is
  // registered, so a URL probes live.
  const [reviewSourceKind, setReviewSourceKind] = useState<ReviewSourceInput['kind']>('pull-request')
  const [reviewPrUrl, setReviewPrUrl] = useState('')
  const [reviewBrBase, setReviewBrBase] = useState('')
  const [reviewBrHead, setReviewBrHead] = useState('')
  const [reviewBranches, setReviewBranches] = useState<GitBranchSnapshot | null>(null)
  const [reviewPatchText, setReviewPatchText] = useState('')
  const [reviewPatchLabel, setReviewPatchLabel] = useState('')
  // The live source probe (review:detect-source) for the current fields.
  const [reviewProbe, setReviewProbe] = useState<ReviewProbeState>({ status: 'idle' })
  const [reviewKgEnabled, setReviewKgEnabled] = useState(true)
  const [reviewGuideCli, setReviewGuideCli] = useState<AgentCli>(
    () => useWorkspaceStore.getState().appSettings.lastSelectedCli ?? 'claude-code',
  )
  const [reviewGuideModel, setReviewGuideModel] = useState<string | null>(null)
  const [reviewDepth, setReviewDepth] = useState<'brief' | 'standard' | 'thorough'>('standard')
  const [reviewError, setReviewError] = useState<string | null>(null)

  // Module-contributed creation step (WorkspaceTypeDefinition.creationStep):
  // the collected value lives here for the pane's lifetime only and resets on
  // mode change; `broken` records a thrown step component, degrading the flow
  // to the type's zero-config path instead of blocking the hub.
  const [moduleStepValue, setModuleStepValue] = useState<unknown>(undefined)
  const [moduleStepBroken, setModuleStepBroken] = useState(false)
  useEffect(() => {
    setModuleStepValue(undefined)
    setModuleStepBroken(false)
  }, [mode])

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
  // CLI default/no model flag).
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
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
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
      }, cliModelCatalog),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      appCliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
    ],
  )
  // Once detection is trustworthy, remap any role default seeded to an
  // uninstalled CLI (e.g. the Claude Code seed, or a saved roster's Claude Code on
  // a Codex-only machine) to an installed agent so creation never deploys — or
  // even offers as the selected value — a CLI the user does not have. No-op when
  // the values are already installed (setState bails on the same reference).
  // Depends on the current defaults too so loading a saved roster (which sets new
  // defaults without changing availability) is re-clamped. The remap is
  // idempotent — it returns the same object reference when nothing needs
  // changing, so setState bails and this converges without looping.
  // The roster half of this remap moved into useRosterEditor with the roster
  // state (MC-1879); the guided-brief half stays here with its own defaults.
  useEffect(() => {
    if (cliAvailabilityStatus !== 'ready') return
    setGuidedRoleCliDefaults((current) => remapRoleCliDefaultsToAvailable(current, sprintEngineCliOptions))
  }, [cliAvailabilityStatus, sprintEngineCliOptions, guidedRoleCliDefaults])

  // MC-1879: roster-editing state lives in useRosterEditor. With the wizard's
  // sprint flow gone (MC-2062) the hub keeps the hook only for the Guided Brief
  // handoff, which seeds its build roster from the resolved (saved-roster-aware,
  // availability-remapped) role CLI defaults and reads the role registry for the
  // roster summary it writes into the handoff.
  const roster = useRosterEditor({
    cliOptions: sprintEngineCliOptions,
    cliAvailabilityStatus,
    workspaceRoot: folderPath,
  })
  const rosterRoleCliDefaults = roster.roleCliDefaults
  const rosterRoleRegistry = roster.registry
  // The user-disabled role set, read by the guided-brief build roster below.
  const sprintEngineDisabledRoleIds = useMemo(
    () => getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings),
    [sprintEngineRoleSettings],
  )

  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const [integrationsMcpCatalog, setIntegrationsMcpCatalog] = useState<McpCatalogServer[]>([])
  const [integrationsMessage] = useState<string | null>(null)
  // Surfaced when create-time Advanced setup persistence (MCP sync, knowledge
  // root, design system) fails, so the wizard reports the failure instead of
  // closing as success.
  const [advancedSetupError, setAdvancedSetupError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.mcpListCatalog === 'function') {
      void window.api.mcpListCatalog().then((result) => {
        if (cancelled) return
        if (result.ok) setIntegrationsMcpCatalog(result.servers)
      }).catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [])

  // The role-registry read moved into useRosterEditor with the rest of the
  // roster state (MC-1879).

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

  // Attach is offered on the build entry points (standard, Design Wizard) —
  // never on the design-system authoring preset, which owns design-system/ as
  // its work product, and never on the zero-config flows that skip Advanced
  // setup.
  const designSystemAttachEligible =
    mode === 'standard'
    || (mode === 'guided-brief' && guidedPreset !== 'design-system')

  // Knowledge folder currently stored for the chosen project (case-preserved
  // key, matching the project-keyed store). Declared before
  // persistAdvancedSetup, which reads it for the attach step's bonus note.
  const committedKnowledgeRoot = useMemo(() => {
    const key = normalizeProjectRootKey(folderPath)
    return key ? projectKnowledgeRoots?.[key] ?? null : null
  }, [folderPath, projectKnowledgeRoots])

  const isReview = mode === REVIEW_WORKSPACE_MODE
  // The typed source the probe + ingest consume, or null when the fields are not
  // yet fillable (empty URL/patch, or a branch pair not chosen).
  const reviewSourceInput = useMemo<ReviewSourceInput | null>(() => {
    if (reviewSourceKind === 'pull-request') {
      const url = reviewPrUrl.trim()
      return url ? { kind: 'pull-request', url } : null
    }
    if (reviewSourceKind === 'branch') {
      const baseRef = reviewBrBase.trim()
      const headRef = reviewBrHead.trim()
      if (!folderPath || !baseRef || !headRef) return null
      return { kind: 'branch', repoRoot: folderPath, baseRef, headRef }
    }
    if (reviewPatchText.trim().length === 0) return null
    const label = reviewPatchLabel.trim()
    return label ? { kind: 'patch', text: reviewPatchText, label } : { kind: 'patch', text: reviewPatchText }
  }, [reviewSourceKind, reviewPrUrl, reviewBrBase, reviewBrHead, folderPath, reviewPatchText, reviewPatchLabel])

  // Debounced live probe (review:detect-source). Never throws to the UI — an
  // unresolvable ref, an unregistered provider (pull-request until MC-1678), or
  // an unparsable patch comes back as an inline error that keeps Start
  // walkthrough disabled.
  useEffect(() => {
    if (!isReview) return
    if (!reviewSourceInput) {
      setReviewProbe({ status: 'idle' })
      return
    }
    const input = reviewSourceInput
    let cancelled = false
    const timer = setTimeout(() => {
      setReviewProbe({ status: 'probing' })
      void window.api
        .reviewDetectSource(input)
        .then((probe) => {
          if (cancelled) return
          setReviewProbe(
            probe.ok
              ? { status: 'ok', probe }
              : { status: 'error', message: probe.error ?? 'Could not read this source.' },
          )
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setReviewProbe({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isReview, reviewSourceInput])

  // Load local branches for the Branch source so the base/head pickers offer
  // real refs (and seed sensible defaults: head = current branch, base = the
  // project's mainline).
  useEffect(() => {
    if (!isReview || reviewSourceKind !== 'branch' || !folderPath) return
    let cancelled = false
    void window.api
      .getGitBranches(folderPath)
      .then((snapshot) => {
        if (cancelled) return
        setReviewBranches(snapshot)
        setReviewBrHead((current) => current || snapshot.current || '')
        setReviewBrBase((current) => current || pickReviewBaseDefault(snapshot))
      })
      .catch(() => {
        if (!cancelled) setReviewBranches(null)
      })
    return () => {
      cancelled = true
    }
  }, [isReview, reviewSourceKind, folderPath])

  // Default the knowledge-graph toggle on only when the project actually has one.
  useEffect(() => {
    if (!isReview) return
    setReviewKgEnabled(Boolean(committedKnowledgeRoot))
  }, [isReview, committedKnowledgeRoot])

  // Keep the guide engine clamped to an installed CLI once detection is
  // trustworthy, mirroring the roster pickers — never offer/seed an uninstalled
  // agent as the guide.
  useEffect(() => {
    if (!isReview || cliAvailabilityStatus !== 'ready') return
    setReviewGuideCli((current) => resolveAvailableAgentCli(current, sprintEngineCliOptions, current))
  }, [isReview, cliAvailabilityStatus, sprintEngineCliOptions])

  const reviewSourceReady = reviewProbe.status === 'ok'
  const reviewGuideConfig = useMemo<ReviewGuideConfig>(
    () => ({
      engineCli: reviewGuideCli,
      engineModel: reviewGuideModel,
      depth: reviewDepth,
      knowledgeGraph: reviewKgEnabled,
    }),
    [reviewGuideCli, reviewGuideModel, reviewDepth, reviewKgEnabled],
  )

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

  // The pane pages through its flow one step at a time.
  const [step, setStep] = useState<StepId>('workspace')
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

  // 'chat' is the shell-owned pseudo-type: on the mode step it swaps the config
  // region for the embedded AgentComposer, which owns the chat's create action.
  const isChat = mode === 'chat'

  const steps = useMemo(() => {
    const base = stepsForMode(mode)
    return knowledgeStepEligible ? base : base.filter((id) => id !== 'knowledge')
  }, [mode, knowledgeStepEligible])
  // The hub pages a mode's flow: the name+folder fields ('workspace') first,
  // then each config step on its own page, in flow order.
  const configSteps = useMemo(
    () => steps.filter((id) => id !== 'workspace'),
    [steps],
  )
  const stepIndex = stepIndexIn(steps, step)
  const isLastStep = isLastStepIn(steps, step)
  // The active mode's contributed creation step, if any: its registered
  // heading replaces the shell's 'module-step' placeholder wherever the page
  // is named (progress labels, back-jump titles, the page heading itself).
  const moduleCreationStep =
    mode !== 'standard' && mode !== 'chat'
      ? getRendererHost().getWorkspaceType(mode)?.creationStep ?? null
      : null
  const stepLabels = useMemo(
    () =>
      steps.map((id) => {
        if (id === 'module-step' && moduleCreationStep) return moduleCreationStep.heading
        return STEP_HEADING[id].title
      }),
    [steps, moduleCreationStep],
  )
  // The optional Advanced setup disclosure rides the flow's final page, for any
  // flow with real config steps; the zero-config quick flows (chat, switchboard,
  // automations) defer that configuration to Settings, exactly as before.
  // Review's source page owns its own "Walkthrough context" rows (knowledge graph,
  // guide, depth), so the generic Advanced setup disclosure would duplicate the
  // knowledge control — suppress it.
  // 'standard' is listed explicitly because it no longer HAS a config step: the
  // layout picker it used to ride on was removed, and gating purely on
  // configSteps.length would have taken create-time MCP / knowledge / design-system
  // access down with it. Only the layout page was ruled out, not this disclosure.
  const showAdvancedSetup =
    (configSteps.length > 0 || mode === 'standard')
    && isLastStep
    && mode !== REVIEW_WORKSPACE_MODE

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

  // Ready when the workspace is named and the folder field resolves to a usable
  // target: an existing folder (opened as-is) or a structurally valid path we
  // can create. Creation/opening happens on continue (`materializeWorkspaceFolder`).
  const folderTargetUsable =
    folderDraftExists === true || analyzeWorkspaceTargetPath(folderDraftPath).ok
  const workspaceStepReady = folderTargetUsable && name.trim().length > 0
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

  // The module step gates create only through its own optional isReady; a
  // broken (thrown) component degrades to zero-config, so it never blocks.
  // isReady is module code running in the shell's render path, outside the
  // step's error boundary — a throw here must fail open (never block the
  // hub), like the thrown-Component degradation.
  const moduleStepReady =
    !configSteps.includes('module-step')
    || moduleStepBroken
    || moduleCreationStep == null
    || !moduleCreationStep.isReady
    || (() => {
      try {
        return moduleCreationStep.isReady(moduleStepValue) === true
      } catch (error) {
        console.error('[modules] workspace creation step isReady threw:', error)
        return true
      }
    })()

  const stepReadiness = {
    workspaceStepReady,
    guidedIdeaReady,
    reviewSourceReady,
    moduleStepReady,
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
  const blockingMessage = getStepBlockingMessage({
    step: hintStep,
    workspaceFolderReady: folderTargetUsable,
    name,
    moduleStepReady,
    moduleStepBlockedHint: moduleCreationStep?.blockedHint ?? null,
    guidedIdea,
    guidedHasUi,
    guidedSeedMode,
    guidedSeedReady,
    committedKnowledgeRoot,
    reviewProbeStatus: reviewProbe.status,
    reviewProbeMessage: reviewProbe.status === 'error' ? reviewProbe.message : null,
    reviewHasSource: reviewSourceInput != null,
  })

  const handleSelectMode = (next: CreationMode) => {
    // A type switch during an in-flight create would hand the deferred
    // handleCreate a different mode than the one the user confirmed.
    if (isCreating || pendingCreate) return
    // Sprint creation is the New sprint dialog (MC-2062), not a wizard flow:
    // the rail row hands off, scoped to whatever folder the hub already holds.
    if (next === SPRINT_ENGINE_WORKSPACE_MODE) {
      onOpenNewSprintDialog(folderPath)
      return
    }
    setMode(next)
    // Every flow starts at 'workspace' (see creationStepFlows): a rail switch
    // restarts the new type's flow rather than stranding the user on page 3 of
    // the old one.
    setStep('workspace')
    setDirection('forward')
    if (next === 'standard' && !nameTouched) setName(basename(folderPath ?? '') || 'workspace')
    if (next === 'switchboard' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Switchboard')
    if (next === 'guided-brief' && !nameTouched)
      setName(toTitleName(basename(folderPath ?? '')) || 'Design Wizard')
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
  }

  const handleSelectFolder = (dir: string) => {
    const folderName = basename(dir)
    setFolderPath(dir)
    setKnowledgeStepEligible(shouldShowKnowledgeStep(dir, projectKnowledgeRoots))
    if (!nameTouched) setName(folderName || 'workspace')
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

  const setGuidedRoleCli = (role: keyof GuidedBriefRoleCliDefaults, cli: AgentCli) => {
    setGuidedRoleCliDefaults((current) => ({ ...current, [role]: cli }))
  }

  const setGuidedRoleModel = (role: keyof GuidedBriefRoleCliDefaults, model: string | null) => {
    setGuidedRoleModelOverrides((current) => ({ ...current, [role]: model }))
  }

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

  const persistLastPermissionPreset = () => {
    setLastAgentSpawnPermissionPreset(cliPermissionPreset)
  }

  const handleCreate = async () => {
    // 'chat' has no wizard create path: it is created by the embedded composer's
    // own confirmation path (host solo-chat create). Guard so an Enter that reaches the
    // section handler on the chat mode step can never fall through to Standard.
    if (isChat) return

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
                buildRoleCliDefaults: rosterRoleCliDefaults,
                buildCliPermissionPreset: cliPermissionPreset,
                // The product default (run agents + approve eligible
                // artifacts); the guided handoff surface owns any change.
                buildStartRunner: true,
                buildAutoApproveArtifacts: true,
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
                buildRoleCliDefaults: rosterRoleCliDefaults,
                buildCliPermissionPreset: cliPermissionPreset,
                // The product default (run agents + approve eligible
                // artifacts); the guided handoff surface owns any change.
                buildStartRunner: true,
                buildAutoApproveArtifacts: true,
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

    if (mode === REVIEW_WORKSPACE_MODE) {
      // Start walkthrough: create the workspace, then materialize its change set.
      // Guarded on a resolved source, so the probe already validated it.
      if (!folderPath || !reviewSourceInput || !reviewSourceReady) return
      const source = reviewSourceInput
      setIsCreating(true)
      setReviewError(null)
      try {
        await runReviewCreation(
          { name, folderPath, source, guideConfig: reviewGuideConfig },
          {
            addReviewWorkspace: ({ name: reviewName, folderPath: reviewFolder, guideConfig }) =>
              addWorkspace(createReviewTemplate(), {
                name: reviewName,
                folderPath: reviewFolder,
                mode: REVIEW_WORKSPACE_MODE,
                reviewGuideConfig: guideConfig,
                windowId: workspaceWindowId,
              }),
            removeWorkspace,
            ingestSource: window.api.reviewIngestSource,
          },
        )
        onClose()
      } catch (error) {
        setReviewError(
          error instanceof ReviewControllerError && error.message !== error.code
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Could not create the review.',
        )
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
      const args = buildModuleTypeCreation({
        mode,
        name,
        folderPath,
        stepValue: moduleStepBroken ? undefined : moduleStepValue,
      })
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

  const handleGuidedStartBuild = async (
    runtimeState: GuidedBriefRuntimeState,
    runOptions: {
      startRunner: boolean
      autoApproveArtifacts: boolean
      roleCounts: SprintEngineRoleCounts
      roleCliDefaults: Required<SprintEngineRoleCliDefaults>
      cliPermissionPreset: SprintEngineCliPermissionPreset
    },
  ) => {
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
          rosterSummary: sprintEngineRosterSummary(finalRoleCounts, rosterRoleRegistry),
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
    ? createLabelFor(mode, isCreating || pendingCreate)
    : 'Continue'
  // One skip control, not two: the flow's remaining pages are all defaulted the
  // moment createReady turns true, so from there the user can leave at any time.
  // A per-page Skip button as well would make people stop and read the footer.
  const showSkipToCreate = shouldShowSkipToCreate({ createReady, isLastStep })
  const stepHeading =
    step === 'module-step' && moduleCreationStep
      ? { title: moduleCreationStep.heading, subtitle: moduleCreationStep.description ?? '' }
      : STEP_HEADING[step]
  const stepAnimationClass =
    direction === 'forward' ? 'wizard-step-in-forward' : 'wizard-step-in-backward'
  // Every page keeps the 560px measure the shared fields read at.
  const stepColumnClass = 'max-w-[560px]'

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
            sprintEngineRoleRegistry={rosterRoleRegistry}
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
              <MulticodeMark className="size-icon-md" variant="mono" />
              <h2
                id="new-workspace-title"
                className="text-body font-semibold text-[color:var(--text-strong)]"
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
                variant="dashes"
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
                      className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
                    >
                      {currentModeModel.label}
                    </h3>
                    <p className="text-body leading-5 text-[color:var(--text-muted)]">
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
                          aria-label="Back"
                          className="
                            -ml-1.5 inline-flex h-7 w-fit max-w-full items-center gap-1 rounded-md px-1.5 text-meta font-medium text-[color:var(--text-subtle)]
                            transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                            focus-visible:focus-ring
                          "
                        >
                          <svg className="icon-sm shrink-0" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
                              className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
                            >
                              {currentModeModel.label}
                            </h3>
                            <p className="text-body leading-5 text-[color:var(--text-muted)]">
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
              inputRef={nameInputRef}
            />
                        </>
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

          {step === 'review-source' ? (
            <ConfigStepSection stepId="review-source" headingRef={headingRef}>
              <ReviewSourceStep
                sourceKind={reviewSourceKind}
                onChangeSourceKind={(kind) => {
                  setReviewSourceKind(kind)
                  setReviewProbe({ status: 'idle' })
                  setReviewError(null)
                }}
                prUrl={reviewPrUrl}
                onChangePrUrl={setReviewPrUrl}
                branches={reviewBranches}
                baseRef={reviewBrBase}
                headRef={reviewBrHead}
                onChangeBaseRef={setReviewBrBase}
                onChangeHeadRef={setReviewBrHead}
                patchText={reviewPatchText}
                onChangePatchText={setReviewPatchText}
                patchLabel={reviewPatchLabel}
                onChangePatchLabel={setReviewPatchLabel}
                probe={reviewProbe}
                knowledgeRoot={committedKnowledgeRoot}
                knowledgeEnabled={reviewKgEnabled}
                onChangeKnowledgeEnabled={setReviewKgEnabled}
                guideCli={reviewGuideCli}
                guideModel={reviewGuideModel}
                guideCliOptions={sprintEngineCliOptions}
                onChangeGuideCli={(nextCli) => {
                  setReviewGuideCli(nextCli)
                  setReviewGuideModel(null)
                }}
                onChangeGuideModel={(_cli, model) => setReviewGuideModel(model)}
                depth={reviewDepth}
                onChangeDepth={setReviewDepth}
                createError={reviewError}
              />
            </ConfigStepSection>
          ) : null}

          {/* The module-contributed config page (MC-1534): the registered
              step's own heading in the shared page chrome, behind an error
              boundary that degrades to the type's zero-config create. */}
          {step === 'module-step' && moduleCreationStep ? (
            <ModuleCreationStepSection
              step={moduleCreationStep}
              headingRef={headingRef}
              value={moduleStepValue}
              setValue={setModuleStepValue}
              broken={moduleStepBroken}
              onBroken={() => setModuleStepBroken(true)}
            />
          ) : null}

          {showAdvancedSetup ? (
            <AdvancedSetupDisclosure
              mcpCatalog={integrationsMcpCatalog}
              mcpSettings={mcpSettings ?? null}
              onToggleMcp={toggleMcpInWizard}
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
              className="border-l-2 border-[color:var(--tone-error)] pl-3 text-meta leading-5 text-[color:var(--tone-error)]"
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
                    <p className="min-w-0 flex-1 truncate text-meta leading-5 text-[color:var(--text-subtle)]">
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
                            inline-flex h-9 items-center rounded-md px-2 text-body font-medium text-[color:var(--text-subtle)]
                            transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
                            disabled:cursor-not-allowed disabled:text-[color:var(--text-disabled)] disabled:hover:bg-transparent
                            focus-visible:focus-ring
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
                          inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-[color:var(--accent-primary)] px-4 text-body font-semibold text-[color:var(--bg-app)]
                          transition-colors hover:bg-[color:var(--accent-primary-hover)]
                          disabled:cursor-not-allowed disabled:bg-[color:var(--bg-surface-raised)] disabled:text-[color:var(--text-disabled)]
                          focus-visible:focus-ring
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
            text-heading text-[color:var(--text-strong)] outline-none transition-colors
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
              font-mono text-meta text-[color:var(--text-strong)] outline-none transition-colors
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
            className={`px-0.5 text-micro leading-4 ${
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
          <div className="px-1 text-micro font-medium text-[color:var(--text-muted)]">
            Recent
          </div>
          <div className="flex min-h-[88px] flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
            {recentFolders.map((recent) => (
              <RecentFolderRow
                key={recent}
                path={recent}
                active={isSameFolder(folderDraftPath, recent)}
                onSelect={onSelectRecent}
              />
            ))}
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
          className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)] outline-none"
        >
          {heading.title}
        </h3>
        <p className="text-body leading-5 text-[color:var(--text-muted)]">{heading.subtitle}</p>
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
    (designSystemAttachSelection ? 1 : 0)

  return (
    <div className="border-t border-[color:var(--border-subtle)] pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="
          flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors
          hover:bg-[color:var(--bg-surface-raised)] focus-visible:focus-ring
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
        <span className="text-body font-medium text-[color:var(--text-strong)]">Advanced setup</span>
        <span className="min-w-0 truncate text-meta text-[color:var(--text-subtle)]">
          Tool integrations and skill packs{knowledgeProjectRoot ? ', knowledge' : ''}{designSystemAttachRoot ? ', design system' : ''} — optional
        </span>
        {selectedCount > 0 ? (
          <span className="ml-auto shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-6 px-1.5 pt-4">
          <section className="flex flex-col gap-2">
            <h4 className="text-meta font-semibold text-[color:var(--text-strong)]">Tool integrations</h4>
            <McpServersStep
              mcpCatalog={mcpCatalog}
              mcpSettings={mcpSettings}
              onToggleMcp={onToggleMcp}
              message={integrationsMessage}
            />
          </section>
          {knowledgeProjectRoot ? (
            <section className="flex flex-col gap-2">
              <h4 className="text-meta font-semibold text-[color:var(--text-strong)]">Knowledge graph</h4>
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
              <h4 className="text-meta font-semibold text-[color:var(--text-strong)]">Design system</h4>
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
        <p className="text-meta leading-5 text-[color:var(--text-muted)]">
          Selected tools are added to this project when you create it. Manage them anytime in Settings.
        </p>
        {mcpCatalog.length > 0 ? (
          <span className="shrink-0 pt-0.5 text-micro tabular-nums text-[color:var(--text-subtle)]">
            {selectedCount} selected
          </span>
        ) : null}
      </div>
      {mcpCatalog.length === 0 ? (
        <p className="text-micro text-[color:var(--text-subtle)]">Loading…</p>
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
                    transition-colors focus-visible:focus-ring
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
                      className="block text-body font-semibold text-[color:var(--text-strong)]"
                    />
                    <span className="mt-0.5 block truncate font-mono text-micro leading-4 text-[color:var(--text-subtle)]">
                      {server.transport} · {server.category ?? 'Other'}
                    </span>
                  </span>
                  {server.recommendedScope === 'user' ? (
                    <span className="rounded-sm border border-[color:var(--border-default)] px-1.5 py-0.5 font-mono text-micro text-[color:var(--text-subtle)]">
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
        <p className="text-micro leading-4 text-[color:var(--text-muted)]">{message}</p>
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
                  className={`min-w-0 flex-1 truncate rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 font-mono text-meta leading-5 ${
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
              <span className="text-meta leading-5 text-[color:var(--text-muted)]">
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
            text-heading leading-6 text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--color-5)] focus:border-[color:var(--text-strong)]
          "
        />
        <span className="text-meta leading-5 text-[color:var(--text-muted)]">{copy.ideaHint}</span>
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
          <p className="text-meta leading-5 text-[color:var(--text-muted)]">{copy.studioNote}</p>
        ) : null}
      </div>

      {folderPath ? (
        <p className="text-meta leading-5 text-[color:var(--text-muted)]">
          {copy.folderHint.before}
          <span className="font-mono text-[color:var(--text-default)]">{copy.folderHint.path}</span>
          {copy.folderHint.after}
        </p>
      ) : null}

      {error ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-meta leading-5 text-[color:var(--tone-error)]">
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
        <span className="block text-meta font-semibold text-[color:var(--text-strong)]">{title}</span>
        <span className="mt-0.5 block text-meta leading-4 text-[color:var(--text-muted)]">{body}</span>
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
          className={`h-4 w-4 shrink-0 accent-[color:var(--accent-primary)] disabled:cursor-not-allowed ${FOCUS_RING_CLASS}`}
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
        flex min-h-[88px] w-full flex-col items-start gap-1.5 overflow-hidden rounded-md border p-3 text-left
        transition-colors focus-visible:focus-ring
        disabled:cursor-not-allowed disabled:opacity-55
        ${active
          ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)]'
          : disabled
            ? 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)]'
            : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
      `}
    >
      <span className="text-body font-semibold leading-4 text-[color:var(--text-strong)]">
        {title}
      </span>
      <span className="text-meta leading-4 text-[color:var(--text-muted)]">{body}</span>
    </button>
  )
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

function createLabelFor(mode: CreationMode, isCreating: boolean): string {
  if (isCreating) return 'Creating…'
  if (mode === REVIEW_WORKSPACE_MODE) return 'Start walkthrough'
  switch (mode) {
    // 'chat' drives create from the embedded composer's own CTA, not this footer,
    // so the footer is hidden for it; the label is defined for completeness.
    case 'chat':
      return 'Start chat'
    case 'switchboard':
      return 'Create Switchboard'
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
    guidedIdeaReady: boolean
    reviewSourceReady: boolean
    moduleStepReady: boolean
  },
): boolean {
  switch (step) {
    case 'workspace':
      return readiness.workspaceStepReady
    case 'mcp-servers':
      return true
    case 'knowledge':
      return true
    case 'guided-idea':
      return readiness.guidedIdeaReady
    case 'review-source':
      return readiness.reviewSourceReady
    case 'module-step':
      return readiness.moduleStepReady
  }
}

// The base ref a review's Branch source defaults to: the project mainline if
// present (never the branch being reviewed), else the first other local branch.
function pickReviewBaseDefault(snapshot: GitBranchSnapshot): string {
  const names = snapshot.branches.map((branch) => branch.name)
  for (const preferred of ['main', 'master', 'develop']) {
    if (preferred !== snapshot.current && names.includes(preferred)) return preferred
  }
  return names.find((name) => name !== snapshot.current) ?? ''
}

function getStepBlockingMessage(args: {
  step: StepId
  workspaceFolderReady: boolean
  name: string
  moduleStepReady: boolean
  moduleStepBlockedHint: string | null
  guidedIdea: string
  guidedHasUi: GuidedBriefHasUi | null
  guidedSeedMode: DesignSystemSeedMode
  guidedSeedReady: boolean
  committedKnowledgeRoot: string | null
  reviewProbeStatus: 'idle' | 'probing' | 'ok' | 'error'
  reviewProbeMessage: string | null
  reviewHasSource: boolean
}): string {
  const {
    step,
    workspaceFolderReady,
    name,
    guidedIdea,
    guidedHasUi,
    guidedSeedMode,
    guidedSeedReady,
    committedKnowledgeRoot,
    reviewProbeStatus,
    reviewProbeMessage,
    reviewHasSource,
  } = args

  switch (step) {
    case 'workspace':
      if (!workspaceFolderReady && !name.trim()) return 'Add a name and choose a folder.'
      if (!workspaceFolderReady) return 'Choose a folder to continue.'
      if (!name.trim()) return 'Give the workspace a name.'
      return 'Ready to create.'
    case 'mcp-servers':
      return 'Pick tool integrations, or skip to add them later from Settings.'
    case 'knowledge':
      return committedKnowledgeRoot
        ? `Knowledge folder: ${committedKnowledgeRoot} — continue, or change it.`
        : 'Pick a knowledge folder, or skip to set it later in Settings.'
    case 'module-step':
      if (!args.moduleStepReady) return args.moduleStepBlockedHint ?? 'Complete the configuration to create.'
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
    case 'review-source':
      if (!reviewHasSource) return 'Point the workspace at a pull request, branch, or patch.'
      if (reviewProbeStatus === 'probing') return 'Reading the changes…'
      if (reviewProbeStatus === 'error') return reviewProbeMessage ?? 'Could not read this source.'
      if (reviewProbeStatus === 'ok') return 'Ready to start the walkthrough.'
      return 'Point the workspace at a pull request, branch, or patch.'
  }
}
