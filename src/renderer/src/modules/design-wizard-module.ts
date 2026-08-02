import type { RendererModule } from './renderer-host'
import { registerDesignWizardWorkspaceTypes } from './design-wizard-workspace-types'

// The `design-wizard` renderer module (MC-1860): the Guided Brief / Canvas
// Studio workspace flow, out of Sprint Engine so it has an identity the module
// system can see.
//
// **This is not the Design door.** Owner ruling 2026-07-30: the Design door
// (`design`, MC-2002) and the Design Wizard are entirely separate things. This
// module owns the `guided-brief` workspace type and nothing else — no global
// surface, no design-system library hosting. The two share the design-system
// bundle substrate (`src/shared/design-system/`) as a dependency only.
//
// Dependency verdict (MC-1860): the wizard needs the SPRINT runtime, not just
// the agent runtime. Its build handoff creates a plan-sourced Sprint Engine
// workspace (`createPlanSourcedSprintEngineWorkspace` in
// GuidedBriefWorkspacePanel) seeded with a Sprint Engine roster, automation
// mode, and CLI permission presets — the wizard's flow culminates in a sprint.
// The interview/design stages additionally run specialist sessions directly on
// the agent runtime. Hence `dependsOn: ['agent-runtime', 'sprint-engine']`:
// disabling Sprint Engine cascades to the wizard by declared dependency, and a
// future out-of-tree extraction is only possible together with sprint-engine or
// after the build handoff is put behind a seam.
export const designWizardRendererModule: RendererModule = {
  manifest: {
    id: 'design-wizard',
    displayName: 'Design Wizard',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary:
      'Turn a plain-words idea into a plan, screens, and a build handoff into a sprint. Disabling hides the Design Wizard workspace mode.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime', 'sprint-engine'],
  },
  registerRenderer(host) {
    registerDesignWizardWorkspaceTypes(host)
  },
}
