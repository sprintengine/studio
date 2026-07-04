import type {
  DesignSystemSeedSource,
  GuidedBriefHasUi,
  GuidedBriefPreset,
  GuidedBriefRoleCliDefaults,
  GuidedBriefRoleModelOverrides,
  GuidedBriefRuntimeState,
  GuidedBriefStage,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
} from '../../../../types/workspace'
import { GuidedBriefWorkspaceError } from '../../../../utils/guidedBriefWorkspace'

// Shared scaffold primitives for the guided-brief preset controllers
// (guidedBriefController, designSystemController). Both build the same
// freshly-created runtime state and wrap workspace-error causes the same way;
// keeping one definition here means a new runtime-state field or error shape
// cannot silently diverge between presets.

export type InitialGuidedBriefRuntimeStateInput = {
  workspaceRoot: string
  workspaceName: string
  idea: string
  hasUi: GuidedBriefHasUi
  preset: GuidedBriefPreset
  wantsProductDiscussion: boolean
  wantsArchitectureDiscussion: boolean
  wantsFrontendDiscussion: boolean
  stage: GuidedBriefStage
  guidedRoleCliDefaults: GuidedBriefRoleCliDefaults
  guidedRoleModelOverrides?: GuidedBriefRoleModelOverrides
  buildRoleCounts: SprintEngineRoleCounts
  buildRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  buildCliPermissionPreset: SprintEngineCliPermissionPreset
  buildStartRunner: boolean
  buildAutoApproveArtifacts: boolean
  // Design-system preset only; the other preset controllers leave it unset
  // and the runtime state records null (blank start).
  designSystemSeedSource?: DesignSystemSeedSource | null
}

/**
 * A just-scaffolded workspace has decided everything above and produced
 * nothing yet: every accepted artifact, selection, and session id starts
 * empty. Controllers supply only the decided fields.
 */
export function buildInitialGuidedBriefRuntimeState(
  input: InitialGuidedBriefRuntimeStateInput,
): GuidedBriefRuntimeState {
  return {
    ...input,
    guidedRoleModelOverrides: input.guidedRoleModelOverrides ?? {},
    designSystemSeedSource: input.designSystemSeedSource ?? null,
    designSystemLastRelease: null,
    acceptedProductBrief: null,
    acceptedArchitecturePlan: null,
    acceptedUiDirection: null,
    acceptedMockups: [],
    activeMockupPath: null,
    activeDesignArtifactPath: null,
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }
}

/**
 * Rethrow a scaffold failure as the controller's coded error: workspace-error
 * codes become the user-facing setup message, other errors keep their own
 * message, and anything else falls through to the controller's default copy.
 */
export function rethrowGuidedScaffoldFailure(
  error: unknown,
  createError: (message?: string) => Error,
): never {
  if (error instanceof GuidedBriefWorkspaceError) {
    throw createError(`Could not set up the Design Wizard workspace (${error.code}).`)
  }
  if (error instanceof Error) {
    throw createError(error.message)
  }
  throw createError()
}
