import type { RendererModule } from './renderer-host'

// Manifest-only for the Automations module until the T1.5 workspace surface
// registers its control center. This keeps Settings -> Modules and the
// bundled-id drift guard aware of the first-party capability without shipping
// a placeholder panel.
export const automationsRendererModule: RendererModule = {
  manifest: {
    id: 'automations',
    displayName: 'Automations',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary: 'Local-first scheduled agent automations with run history and module-gated execution.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
}
