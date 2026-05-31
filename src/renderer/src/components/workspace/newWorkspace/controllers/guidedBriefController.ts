import type {
  GuidedBriefRuntimeState,
  SprintEngineSourceBundleItem,
} from '../../../../types/workspace'
import { countSprintEngineAgents } from '../../../../utils/sprintengine'
import {
  GuidedBriefWorkspaceError,
  scaffoldGuidedBriefWorkspace,
  writeGuidedBriefBuildHandoff,
} from '../../../../utils/guidedBriefWorkspace'
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
  if (input.hasUi == null) throw new GuidedBriefScaffoldError('missing-has-ui')

  const folderPath = input.folderPath
  const hasUi = input.hasUi

  try {
    await scaffoldGuidedBriefWorkspace({
      workspaceRoot: folderPath,
      idea: input.idea,
      hasUi,
      filesystem: ports.filesystem,
    })
  } catch (error) {
    if (error instanceof GuidedBriefWorkspaceError) {
      const wrapped = new GuidedBriefScaffoldError('unknown')
      wrapped.message = `Could not scaffold the guided brief workspace (${error.code}).`
      throw wrapped
    }
    if (error instanceof Error) {
      const wrapped = new GuidedBriefScaffoldError('unknown')
      wrapped.message = error.message
      throw wrapped
    }
    throw new GuidedBriefScaffoldError('unknown')
  }

  const wantsFrontendDiscussion = hasUi === 'yes' && input.wantsFrontend
  const initialStage: GuidedBriefRuntimeState['stage'] = input.wantsProduct
    ? 'strategist-working'
    : input.wantsArchitecture
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

  const workspaceLabel = toTitleName(basename(folderPath)) || input.workspaceName.trim() || 'Guided brief'
  const runtimeState: GuidedBriefRuntimeState = {
    workspaceRoot: folderPath,
    workspaceName: workspaceLabel,
    idea: input.idea,
    hasUi,
    wantsProductDiscussion: input.wantsProduct,
    wantsArchitectureDiscussion: input.wantsArchitecture,
    wantsFrontendDiscussion,
    guidedRoleCliDefaults: input.guidedRoleCliDefaults,
    buildRoleCounts: input.buildRoleCounts,
    buildRoleCliDefaults: input.buildRoleCliDefaults,
    buildCliPermissionPreset: input.buildCliPermissionPreset,
    buildStartRunner: input.buildStartRunner,
    buildAutoApproveArtifacts: input.buildAutoApproveArtifacts,
    stage: initialStage,
    acceptedProductBrief: null,
    acceptedArchitecturePlan: null,
    acceptedUiDirection: null,
    acceptedMockups: [],
    activeMockupPath: null,
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }

  return { runtimeState }
}

export async function runGuidedBriefStartBuild(
  input: GuidedBriefStartBuildInput,
  ports: GuidedBriefStartBuildPorts,
): Promise<void> {
  const { runtimeState, runOptions, finalRoleCounts } = input

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
  const sourceBundle = await buildSprintEngineSourceBundle(
    runtimeState.workspaceRoot,
    sourcePath,
    sourceContent,
    runtimeState.acceptedArchitecturePlan,
    ports.readArchitecturePlan,
  )
  const goal = guidedBriefSprintEngineGoal(sourceContent, runtimeState.hasUi)

  try {
    await createPlanSourcedSprintEngineWorkspace({
      rootPath: runtimeState.workspaceRoot,
      teamName: `${runtimeState.workspaceName} Build`,
      goal,
      sourcePath,
      sourceContent,
      sourcePlanKind: 'product_plan',
      sourceBundle,
      roleCounts: finalRoleCounts,
      roleCliDefaults: runOptions.roleCliDefaults,
      workspaceWindowId: input.workspaceWindowId,
      sprintEngineAutoState: {
        enabled: runOptions.startRunner,
        autoApproveArtifacts: runOptions.autoApproveArtifacts,
        cliPermissionPreset: runOptions.cliPermissionPreset,
        maxConcurrentAgents: Math.max(1, countSprintEngineAgents(finalRoleCounts)),
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

async function buildSprintEngineSourceBundle(
  workspaceRoot: string,
  handoffPath: string,
  handoffContent: string,
  architecturePlan: GuidedBriefRuntimeState['acceptedArchitecturePlan'],
  readArchitecturePlan: GuidedBriefStartBuildPorts['readArchitecturePlan'],
): Promise<SprintEngineSourceBundleItem[] | undefined> {
  if (!architecturePlan) return undefined
  const architectureContent = await readArchitecturePlan(workspaceRoot, architecturePlan.path)
  return [
    {
      kind: 'product_plan',
      sourcePath: handoffPath,
      sourceRelativePath: handoffPath,
      sourceContent: handoffContent,
    },
    {
      kind: 'architect_plan',
      sourcePath: architecturePlan.path,
      sourceRelativePath: architecturePlan.path,
      sourceContent: architectureContent,
    },
  ]
}
