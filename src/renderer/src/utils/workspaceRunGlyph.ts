import { getRendererHost } from '../modules'
import type { Workspace } from '../types/workspace'
import type { LifecycleState } from '../../../shared/lifecycle-state'

// Mode-level status for a sidebar workspace row, expressed in the shared
// lifecycle vocabulary. This module is the per-mode dispatch point: a
// workspace's status is owned by the module that owns its workspace type, and
// the shell only consumes the derived glyph.
export type WorkspaceRunGlyph = { state: LifecycleState; live: boolean; label: string }

export type WorkspaceRunGlyphProviderInput = Pick<Workspace, 'mode'>

function runGlyphProviderForWorkspace(workspace: WorkspaceRunGlyphProviderInput) {
  // Enablement is read off the host rather than the workspace store: the
  // store's own slices reach this module through `workspaceSettle`, so
  // importing the store here would close a cycle and leave whichever module
  // loaded first holding a half-evaluated one.
  const host = getRendererHost()
  const definitions = host.getWorkspaceTypes((moduleId) => host.isModuleEnabled(moduleId))
  // A type's provider is asked about its own workspaces only: the published
  // module contract promises exactly that.
  return definitions.find((definition) => definition.deriveRunGlyph && definition.id === workspace.mode) ?? null
}

// The sidebar row's one status slot. The owning module's provider derives the
// glyph from its own state, with terminals deliberately excluded: an ephemeral
// agent terminal sitting at a prompt must not drive a run's status. A workspace
// with no provider gets no run glyph (the shell's dot + recency idiom stays its
// own). Null means "no run signal": the caller falls back to recency text.
export function deriveWorkspaceRunGlyph(workspace: WorkspaceRunGlyphProviderInput): WorkspaceRunGlyph | null {
  const provider = runGlyphProviderForWorkspace(workspace)
  if (!provider) return null
  return provider.deriveRunGlyph?.(workspace) ?? null
}
