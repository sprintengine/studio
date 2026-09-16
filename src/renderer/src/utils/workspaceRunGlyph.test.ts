import assert from 'node:assert/strict'
import { deriveWorkspaceRunGlyph } from './workspaceRunGlyph'
import type { WorkspaceRunGlyphProviderInput } from './workspaceRunGlyph'
import { getRendererHost, selectModuleEnabled } from '../modules'
import { useWorkspaceStore } from '../store/workspaceStore'

// The sidebar row's one status slot is DISPATCHED, not computed here: the
// module that owns a workspace's type derives its own glyph, and this file only
// decides which provider is asked. No bundled type ships one today, so the
// contract is exercised against types registered here — the same registry the
// shell reads.
//
// Two rules, and they are the whole of it:
//   · only the provider of the workspace's own MODE is asked;
//   · a disabled module's provider is not asked at all.

const PROBE_MODULE = 'automations'
const host = getRendererHost()

// Enablement reaches the dispatcher through the host's resolver, which
// `modules/index.ts` wires from the workspace store at boot. Wire the same
// thing here, so toggling the module in the store is what the dispatcher sees.
host.setModuleEnablementResolver((moduleId) =>
  selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId)
)

function registerProbeType(id: string, options: {
  deriveRunGlyph?: (workspace: WorkspaceRunGlyphProviderInput) => ReturnType<typeof deriveWorkspaceRunGlyph>
}): void {
  host.hostFor(PROBE_MODULE).registerWorkspaceType({
    id,
    label: id,
    description: 'Test-only workspace type.',
    icon: () => null,
    hiddenFromPicker: true,
    createTemplate: () => ({
      id,
      name: id,
      description: 'Test-only workspace type.',
      previewSlots: [],
      layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    }),
    ...options,
  } as never)
}

// The mode owner.
registerProbeType('run-glyph-probe', {
  deriveRunGlyph: () => ({ state: 'in_progress', live: true, label: 'Running' }),
})

useWorkspaceStore.getState().setModuleEnabled(PROBE_MODULE, true)

const workspace = (
  overrides: Partial<WorkspaceRunGlyphProviderInput> = {},
): WorkspaceRunGlyphProviderInput => ({
  mode: 'standard',
  ...overrides,
})

// A workspace whose mode nothing claims gets no run glyph — the shell's dot +
// recency idiom stays its own.
assert.equal(deriveWorkspaceRunGlyph(workspace()), null)
assert.equal(
  deriveWorkspaceRunGlyph(workspace({ mode: 'no-such-type' })),
  null,
  'a workspace type without a run-glyph provider falls back to the dot/recency idiom',
)

// The mode's own provider answers.
assert.deepEqual(deriveWorkspaceRunGlyph(workspace({ mode: 'run-glyph-probe' })), {
  state: 'in_progress',
  live: true,
  label: 'Running',
})

// A provider is free to answer "no run signal" for a workspace it owns.
registerProbeType('run-glyph-quiet', { deriveRunGlyph: () => null })
assert.equal(deriveWorkspaceRunGlyph(workspace({ mode: 'run-glyph-quiet' })), null)

// Module enablement gates the provider: a disabled module is not asked.
useWorkspaceStore.getState().setModuleEnabled(PROBE_MODULE, false)
assert.equal(
  deriveWorkspaceRunGlyph(workspace({ mode: 'run-glyph-probe' })),
  null,
  'a disabled module’s run-glyph provider is not consulted',
)
useWorkspaceStore.getState().setModuleEnabled(PROBE_MODULE, true)

console.log('workspaceRunGlyph tests passed')
