import type { LayoutTemplate } from '../../../../types/workspace'
import { LAYOUT_TEMPLATES } from '../../../../layouts/templates'
import type { OnCreateArgs } from './types'

export type StandardControllerInput = {
  layoutId: string
  name: string
  folderPath: string | null
  /** User-installed templates, searched alongside the bundled ones. */
  userTemplates?: LayoutTemplate[]
}

export function buildStandardCreation(input: StandardControllerInput): OnCreateArgs {
  const candidates: LayoutTemplate[] = [...LAYOUT_TEMPLATES, ...(input.userTemplates ?? [])]
  const template = candidates.find((candidate) => candidate.id === input.layoutId) ?? LAYOUT_TEMPLATES[0]
  return {
    template,
    name: input.name.trim(),
    folderPath: input.folderPath,
  }
}
