import { getRendererHost } from '../../../../modules'
import type {
  WorkspaceTypeCreateHost,
  WorkspaceTypeCreateRequest,
} from '../../../../modules/renderer-host'
import type { WorkspaceMode } from '../../../../types/workspace'
import type { OnCreateArgs } from './types'

// Creation for module-contributed workspace types (no shell controller of
// their own): the registered definition's createTemplate() IS the layout, the
// same contract switchboard/automations follow. Reached for any registered
// type whose mode has no explicit branch in NewWorkspacePanel.

export type ModuleTypeControllerInput = {
  mode: string
  name: string
  folderPath: string | null
  /** The module creation step's collected value; undefined without a step. */
  stepValue?: unknown
}

export class ModuleTypeControllerError extends Error {
  constructor(public readonly code: 'missing-folder' | 'unknown-type') {
    super(code)
    this.name = 'ModuleTypeControllerError'
  }
}

export function buildModuleTypeCreation(input: ModuleTypeControllerInput): OnCreateArgs {
  const definition = getRendererHost().getWorkspaceType(input.mode)
  if (!definition) throw new ModuleTypeControllerError('unknown-type')
  if (!input.folderPath) throw new ModuleTypeControllerError('missing-folder')
  return {
    template: definition.createTemplate({ stepValue: input.stepValue }),
    name: input.name.trim() || definition.label,
    folderPath: input.folderPath,
    mode: input.mode as WorkspaceMode,
  }
}

export type ModuleTypeAsyncCreationInput = ModuleTypeControllerInput & {
  /** Write back into the module's creation step value (MC-2090). */
  setStepValue: (value: unknown) => void
}

export type ModuleTypeAsyncCreationPorts = {
  /** Mints the row from a template, returning its id. The store's addWorkspace. */
  addWorkspace: (args: OnCreateArgs) => string
  removeWorkspace: (workspaceId: string) => void
}

/**
 * Run a contributed type's own async create hook (MC-2090). The module owns the
 * orchestration; the shell owns only the two capabilities it needs — mint this
 * type's workspace, and take it back — so a hook that fails after minting can
 * roll back rather than leaving an empty row behind.
 *
 * Returns false when the type has no hook, so the caller falls through to the
 * plain `buildModuleTypeCreation` path unchanged. A hook that rejects
 * propagates: the hub stays open with the create still available.
 */
export async function runModuleTypeCreation(
  input: ModuleTypeAsyncCreationInput,
  ports: ModuleTypeAsyncCreationPorts,
): Promise<boolean> {
  const definition = getRendererHost().getWorkspaceType(input.mode)
  if (!definition) throw new ModuleTypeControllerError('unknown-type')
  if (!definition.createWorkspace) return false
  if (!input.folderPath) throw new ModuleTypeControllerError('missing-folder')
  const folderPath = input.folderPath
  const request: WorkspaceTypeCreateRequest = {
    name: input.name,
    folderPath,
    stepValue: input.stepValue,
    setStepValue: input.setStepValue,
  }
  // `createWorkspace` runs the SAME build the zero-config path would have run,
  // so the layout a type gets is identical whichever branch created it, and the
  // step value reaches createTemplate either way.
  const host: WorkspaceTypeCreateHost = {
    createWorkspace: (options) =>
      ports.addWorkspace(
        buildModuleTypeCreation({
          ...input,
          name: options?.name ?? input.name,
          folderPath,
        }),
      ),
    removeWorkspace: ports.removeWorkspace,
  }
  await definition.createWorkspace(request, host)
  return true
}
