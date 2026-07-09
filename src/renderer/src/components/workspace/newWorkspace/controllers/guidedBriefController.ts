import type { GuidedBriefRuntimeState } from '../../../../types/workspace'
import { SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS } from './sprintEngineController'
import {
  sprintEngineAutomationInitialStateForMode,
  sprintEngineAutomationModeForRunOptions,
} from '../../../../utils/sprintengineAutomationLifecycle'
import {
  buildGuidedBriefSprintEngineSourceBundle,
  scaffoldGuidedBriefWorkspace,
  writeGuidedBriefBuildHandoff,
} from '../../../../utils/guidedBriefWorkspace'
import {
  buildInitialGuidedBriefRuntimeState,
  rethrowGuidedScaffoldFailure,
} from './guidedBriefScaffolding'
import {
  buildScaffoldBaseline,
  writeScaffoldBaseline,
} from '../../guidedBrief/designArtifacts'
import {
  PlanSourcedSprintEngineWorkspaceError,
  createPlanSourcedSprintEngineWorkspace,
} from '../../../../utils/sprintengineWorkspaceCreation'
import { guidedBriefSprintEngineGoal } from '../../guidedBrief/handoff'
import { basename, toTitleName } from '../helpers'
import type {
  GuidedBriefScaffoldInput,
  GuidedBriefScaffoldPorts,
  GuidedBriefScaffoldResult,
  GuidedBriefStartBuildInput,
  GuidedBriefStartBuildPorts,
} from './types'

export class GuidedBriefScaffoldError extends Error {
  constructor(public readonly code: 'missing-folder' | 'missing-idea' | 'missing-has-ui' | 'unknown') {
    super(code)
    this.name = 'GuidedBriefScaffoldError'
  }
}

export class GuidedBriefStartBuildError extends Error {
  constructor(
    public readonly code:
      | 'missing-product-brief'
      | 'missing-architecture-plan'
      | 'missing-ui-direction-or-mockups'
      | 'design-system-preset'
      | 'advanced-setup-failed'
      | 'team-exists'
      | 'unknown',
  ) {
    super(code)
    this.name = 'GuidedBriefStartBuildError'
  }
}

export async function runGuidedBriefScaffold(
  input: GuidedBriefScaffoldInput,
  ports: GuidedBriefScaffoldPorts,
): Promise<GuidedBriefScaffoldResult> {
  if (!input.folderPath) throw new GuidedBriefScaffoldError('missing-folder')
  if (!input.idea.trim()) throw new GuidedBriefScaffoldError('missing-idea')

  const preset: GuidedBriefRuntimeState['preset'] = input.preset === 'frontend-design'
    ? 'frontend-design'
    : 'full-brief'
  const isDesignPreset = preset === 'frontend-design'

  // Multicode Design is a design-only studio: UI is implied, the product and
  // architecture discussions are off, and the frontend discussion is always on.
  // These are forced here so the preset stays authoritative regardless of which
  // discussion flags the caller passed.
  const hasUi = isDesignPreset ? 'yes' : input.hasUi
  if (hasUi == null) throw new GuidedBriefScaffoldError('missing-has-ui')

  const folderPath = input.folderPath
  const wantsProduct = isDesignPreset ? false : input.wantsProduct
  const wantsArchitecture = isDesignPreset ? false : input.wantsArchitecture

  try {
    // Baseline first (MC-1502): record what already exists under the shared
    // roots before anything is written, so run-scoped discovery can hide the
    // seed repo's own files. (Scaffold writes never land under those roots —
    // idea-seed.md is not indexed and .versions/ is dotfile-skipped — but
    // "before any write" is the honest reading of 'pre-existing'.)
    const baseline = await buildScaffoldBaseline(folderPath, ports.discovery)
    await scaffoldGuidedBriefWorkspace({
      workspaceRoot: folderPath,
      idea: input.idea,
      hasUi,
      filesystem: ports.filesystem,
    })
    await writeScaffoldBaseline(folderPath, baseline, ports.filesystem)
  } catch (error) {
    rethrowGuidedScaffoldFailure(error, (message) => {
      const wrapped = new GuidedBriefScaffoldError('unknown')
      if (message) wrapped.message = message
      return wrapped
    })
  }

  const wantsFrontendDiscussion = isDesignPreset
    ? true
    : hasUi === 'yes' && input.wantsFrontend
  const initialStage: GuidedBriefRuntimeState['stage'] = wantsProduct
    ? 'strategist-working'
    : wantsArchitecture
      ? 'architect-working'
      : wantsFrontendDiscussion
        ? 'designer-working'
        : 'handoff'

  if (initialStage === 'handoff') {
    await writeGuidedBriefBuildHandoff({
      workspaceRoot: folderPath,
      idea: input.idea,
      hasUi,
      productBrief: null,
      architecturePlan: null,
      requireMockups: false,
      confirmedDecisions: [
        hasUi === 'yes'
          ? 'Application includes a visual UI, but no frontend design stage was requested.'
          : 'No visual UI is required.',
        'Product strategy discussion was not requested.',
        'Architecture discussion was not requested.',
      ],
      filesystem: ports.filesystem,
    })
  }

  const workspaceLabel = toTitleName(basename(folderPath)) || input.workspaceName.trim() || 'Design Wizard'
  return {
    runtimeState: buildInitialGuidedBriefRuntimeState({
      workspaceRoot: folderPath,
      workspaceName: workspaceLabel,
      idea: input.idea,
      hasUi,
      preset,
      wantsProductDiscussion: wantsProduct,
      wantsArchitectureDiscussion: wantsArchitecture,
      wantsFrontendDiscussion,
      stage: initialStage,
      guidedRoleCliDefaults: input.guidedRoleCliDefaults,
      guidedRoleModelOverrides: input.guidedRoleModelOverrides,
      buildRoleCounts: input.buildRoleCounts,
      buildRoleCliDefaults: input.buildRoleCliDefaults,
      buildCliPermissionPreset: input.buildCliPermissionPreset,
      buildStartRunner: input.buildStartRunner,
      buildAutoApproveArtifacts: input.buildAutoApproveArtifacts,
    }),
  }
}

export async function runGuidedBriefStartBuild(
  input: GuidedBriefStartBuildInput,
  ports: GuidedBriefStartBuildPorts,
): Promise<void> {
  const { runtimeState, runOptions, finalRoleCounts } = input

  // The design-system preset completes with "Save as design system" (the T6
  // release pipeline), never a Sprint Engine build; its studio renders no
  // build tail, so reaching here means a caller bug — refuse loudly.
  if (runtimeState.preset === 'design-system') {
    throw new GuidedBriefStartBuildError('design-system-preset')
  }

  if (runtimeState.wantsProductDiscussion && !runtimeState.acceptedProductBrief) {
    throw new GuidedBriefStartBuildError('missing-product-brief')
  }
  if (runtimeState.wantsArchitectureDiscussion && !runtimeState.acceptedArchitecturePlan) {
    throw new GuidedBriefStartBuildError('missing-architecture-plan')
  }
  if (
    runtimeState.hasUi === 'yes'
    && runtimeState.wantsFrontendDiscussion
    && (!runtimeState.acceptedUiDirection || runtimeState.acceptedMockups.length === 0)
  ) {
    throw new GuidedBriefStartBuildError('missing-ui-direction-or-mockups')
  }

  // Fail-closed preflight: persist the Advanced setup selections (real MCP sync +
  // skill-pack install) before any handoff write or run/workspace creation. If
  // this fails, abort here so a partially-created Sprint Engine workspace is
  // never left behind; the message surfaces on the existing advancedSetupError
  // surface.
  const advancedSetupError = await ports.persistAdvancedSetup(runtimeState.workspaceRoot)
  if (advancedSetupError) {
    const wrapped = new GuidedBriefStartBuildError('advanced-setup-failed')
    wrapped.message = advancedSetupError
    throw wrapped
  }

  await writeGuidedBriefBuildHandoff({
    workspaceRoot: runtimeState.workspaceRoot,
    idea: runtimeState.idea,
    hasUi: runtimeState.hasUi,
    productBrief: runtimeState.acceptedProductBrief,
    architecturePlan: runtimeState.acceptedArchitecturePlan,
    uiDirection: runtimeState.acceptedUiDirection,
    mockups: runtimeState.acceptedMockups,
    requireMockups: runtimeState.hasUi === 'yes' && runtimeState.wantsFrontendDiscussion,
    confirmedDecisions: input.planningDecisions,
    roster: input.rosterSummary,
    validationNotes: input.planningValidationNotes,
    filesystem: ports.filesystem,
  })

  const sourcePath = input.buildHandoffRelativePath
  const sourceContent = await ports.readBuildHandoff(runtimeState.workspaceRoot, sourcePath)
  const sourceBundle = await buildGuidedBriefSprintEngineSourceBundle({
    workspaceRoot: runtimeState.workspaceRoot,
    handoffPath: sourcePath,
    handoffContent: sourceContent,
    productBrief: runtimeState.acceptedProductBrief,
    architecturePlan: runtimeState.acceptedArchitecturePlan,
    uiDirection: runtimeState.acceptedUiDirection,
    mockups: runtimeState.acceptedMockups,
    productOverview: runtimeState.acceptedProductOverview ?? null,
    architectureOverview: runtimeState.acceptedArchitectureOverview ?? null,
    readArtifact: ports.readArchitecturePlan,
  })
  const goal = guidedBriefSprintEngineGoal(sourceContent, runtimeState.hasUi)

  try {
    const createWorkspace = ports.createPlanSourcedSprintEngineWorkspace ?? createPlanSourcedSprintEngineWorkspace
    await createWorkspace({
      rootPath: runtimeState.workspaceRoot,
      teamName: `${runtimeState.workspaceName} Build`,
      goal,
      sourcePath,
      sourceContent,
      sourcePlanKind: 'unknown',
      sourceBundle,
      roleCounts: finalRoleCounts,
      roleCliDefaults: runOptions.roleCliDefaults,
      workspaceWindowId: input.workspaceWindowId,
      sprintEngineAutoState: {
        ...sprintEngineAutomationInitialStateForMode(sprintEngineAutomationModeForRunOptions(runOptions)),
        cliPermissionPreset: runOptions.cliPermissionPreset,
        // MC-1450: the ceiling is a workspace-level knob, never roster size.
        maxConcurrentAgents: SPRINT_ENGINE_DEFAULT_MAX_PARALLEL_AGENTS,
      },
      pathExists: ports.pathExists,
    })
  } catch (error) {
    if (error instanceof PlanSourcedSprintEngineWorkspaceError && error.code === 'team-exists') {
      throw new GuidedBriefStartBuildError('team-exists')
    }
    if (error instanceof Error) {
      const wrapped = new GuidedBriefStartBuildError('unknown')
      wrapped.message = error.message
      throw wrapped
    }
    throw new GuidedBriefStartBuildError('unknown')
  }
}
