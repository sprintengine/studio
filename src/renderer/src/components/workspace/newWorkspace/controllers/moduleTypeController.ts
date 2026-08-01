import { getRendererHost } from '../../../../modules'
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
