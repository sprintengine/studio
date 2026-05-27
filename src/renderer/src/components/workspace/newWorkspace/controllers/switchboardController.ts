import { createSwitchboardTemplate } from '../../../../layouts/templates'
import type { OnCreateArgs } from './types'

export type SwitchboardControllerInput = {
  name: string
  folderPath: string | null
}

export class SwitchboardControllerError extends Error {
  constructor(public readonly code: 'missing-folder') {
    super(code)
    this.name = 'SwitchboardControllerError'
  }
}

export function buildSwitchboardCreation(input: SwitchboardControllerInput): OnCreateArgs {
  if (!input.folderPath) throw new SwitchboardControllerError('missing-folder')
  return {
    template: createSwitchboardTemplate(),
    name: input.name.trim() || 'Switchboard',
    folderPath: input.folderPath,
    mode: 'switchboard',
  }
}
