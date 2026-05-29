import type { IJsonModel } from 'flexlayout-react'

import type { LayoutTemplateManifest } from '../../../shared/layouts/template-manifest'
import type { LayoutTemplate } from '../types/workspace'

// Map a validated user-installed template manifest to the in-app LayoutTemplate
// shape consumed by the new-workspace picker and the standard create path.
// `layout` is already validated as a FlexLayout root; previewSlots default to
// empty (the picker shows name + description without a thumbnail).
export function userLayoutTemplateToTemplate(manifest: LayoutTemplateManifest): LayoutTemplate {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? 'Installed layout template.',
    previewSlots: manifest.previewSlots ?? [],
    layout: manifest.layout as IJsonModel,
  }
}
