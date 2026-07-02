import { scaffoldDesignSystemWorkspaceSeed } from '../../../../utils/guidedBriefWorkspace'
import { basename, toTitleName } from '../helpers'
import {
  buildInitialGuidedBriefRuntimeState,
  rethrowGuidedScaffoldFailure,
} from './guidedBriefScaffolding'
import type {
  DesignSystemScaffoldControllerInput,
  DesignSystemScaffoldControllerPorts,
  GuidedBriefScaffoldResult,
} from './types'

export class DesignSystemScaffoldError extends Error {
  constructor(public readonly code: 'missing-folder' | 'missing-idea' | 'scaffold-failed' | 'unknown') {
    super(code)
    this.name = 'DesignSystemScaffoldError'
  }
}

/**
 * Scaffold for the guided-brief `design-system` preset, following the
 * `runGuidedBriefScaffold` shape. Instead of `product/` + `mockups/`, it
 * stamps the portable bundle layout into `<workspace>/design-system/` through
 * the main-process scaffold port (templates from resources/design-system/)
 * and writes the design goal to `.guided-brief/idea-seed.md`. The preset is
 * authoritative here — like the frontend-design preset, it forces the
 * design-only path (UI implied, product/architecture discussions off, start
 * on the designer stage) regardless of the flags the caller passed.
 */
export async function runDesignSystemScaffold(
  input: DesignSystemScaffoldControllerInput,
  ports: DesignSystemScaffoldControllerPorts,
): Promise<GuidedBriefScaffoldResult> {
  if (!input.folderPath) throw new DesignSystemScaffoldError('missing-folder')
  if (!input.idea.trim()) throw new DesignSystemScaffoldError('missing-idea')
  const folderPath = input.folderPath
  const workspaceLabel =
    toTitleName(basename(folderPath)) || input.workspaceName.trim() || 'Design System'

  const scaffold = await ports.scaffoldBundle(folderPath, workspaceLabel, input.idea)
  if (!scaffold.ok) {
    const wrapped = new DesignSystemScaffoldError('scaffold-failed')
    wrapped.message = scaffold.message ?? 'Could not scaffold the design-system bundle.'
    throw wrapped
  }

  try {
    await scaffoldDesignSystemWorkspaceSeed({
      workspaceRoot: folderPath,
      idea: input.idea,
      filesystem: ports.filesystem,
    })
  } catch (error) {
    rethrowGuidedScaffoldFailure(error, (message) => {
      const wrapped = new DesignSystemScaffoldError('unknown')
      if (message) wrapped.message = message
      return wrapped
    })
  }

  return {
    runtimeState: buildInitialGuidedBriefRuntimeState({
      workspaceRoot: folderPath,
      workspaceName: workspaceLabel,
      idea: input.idea,
      hasUi: 'yes',
      preset: 'design-system',
      wantsProductDiscussion: false,
      wantsArchitectureDiscussion: false,
      wantsFrontendDiscussion: true,
      stage: 'designer-working',
      guidedRoleCliDefaults: input.guidedRoleCliDefaults,
      buildRoleCounts: input.buildRoleCounts,
      buildRoleCliDefaults: input.buildRoleCliDefaults,
      buildCliPermissionPreset: input.buildCliPermissionPreset,
      buildStartRunner: input.buildStartRunner,
      buildAutoApproveArtifacts: input.buildAutoApproveArtifacts,
    }),
  }
}
