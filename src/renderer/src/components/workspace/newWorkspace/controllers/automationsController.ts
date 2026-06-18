import { createAutomationsTemplate } from '../../../../modules/automations-workspace-types'
import type { OnCreateArgs } from './types'

export type AutomationsControllerInput = {
  name: string
  folderPath: string | null
}

export class AutomationsControllerError extends Error {
  constructor(public readonly code: 'missing-folder') {
    super(code)
    this.name = 'AutomationsControllerError'
  }
}

// Automations is strictly per-project (Q3): a folder is required so the engine
// can resolve the project store the control center reads and writes.
export function buildAutomationsCreation(input: AutomationsControllerInput): OnCreateArgs {
  if (!input.folderPath) throw new AutomationsControllerError('missing-folder')
  return {
    template: createAutomationsTemplate(),
    name: input.name.trim() || 'Automations',
    folderPath: input.folderPath,
    mode: 'automations',
  }
}
