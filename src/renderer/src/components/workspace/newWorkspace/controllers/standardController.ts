import type { LayoutTemplate } from '../../../../types/workspace'
import { LAYOUT_TEMPLATES } from '../../../../layouts/templates'
import type { OnCreateArgs } from './types'

export type StandardControllerInput = {
  layoutId: string
  name: string
  folderPath: string | null
}

export function buildStandardCreation(input: StandardControllerInput): OnCreateArgs {
  const template: LayoutTemplate =
    LAYOUT_TEMPLATES.find((candidate) => candidate.id === input.layoutId) ?? LAYOUT_TEMPLATES[0]
  return {
    template,
    name: input.name.trim(),
    folderPath: input.folderPath,
  }
}
