import { getRendererHost, selectModuleEnabled } from '../modules'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace } from '../types/workspace'
import type { LifecycleState } from '../components/ui/LifecycleGlyph'

// Mode-level status for a sidebar workspace row, expressed in the shared
// lifecycle vocabulary. This module is the per-mode dispatch point: a
// workspace's status is owned by the module that owns its workspace type, and
// the shell only consumes the derived glyph.
export type WorkspaceRunGlyph = { state: LifecycleState; live: boolean; label: string }

export type WorkspaceRunGlyphProviderInput = Pick<
  Workspace,
  'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState'
>

function isModuleEnabledForRunGlyph(moduleId: string): boolean {
  return selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId)
}

function runGlyphProviderForWorkspace(workspace: WorkspaceRunGlyphProviderInput) {
  const definitions = getRendererHost().getWorkspaceTypes(isModuleEnabledForRunGlyph)
  // The mode's own provider wins: the published module contract promises a
  // type's provider is called for its own workspaces. Predicate-based claims
  // (Sprint Engine context riding a workspace of another mode) apply only
  // when the workspace's own mode ships no provider.
  const modeOwner = definitions.find(
    (definition) => definition.deriveRunGlyph && definition.id === workspace.mode
  )
  if (modeOwner) return modeOwner
  return definitions.find((definition) => {
    if (!definition.deriveRunGlyph) return false
    return definition.isRunGlyphProviderForWorkspace?.(workspace) === true
  }) ?? null
}

// The sidebar row's one status slot. The owning module's provider derives the
// glyph from its own state — for a Sprint Engine run that is a pure function of
// sprint state (the task board + AutoRun runtime), with terminals deliberately
// excluded: an ephemeral agent terminal sitting at a prompt must not drive a
// run's status. A workspace with no provider gets no run glyph (the shell's
// dot + recency idiom stays its own). Null means "no run signal": the caller
// falls back to recency text.
export function deriveWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
): WorkspaceRunGlyph | null {
  const provider = runGlyphProviderForWorkspace(workspace)
  if (!provider) return null
  return provider.deriveRunGlyph?.(workspace) ?? null
}

// True when the workspace's mode owns a run-glyph provider — i.e. its status is
// provider-derived, not terminal-derived. Callers use this to suppress the
// terminal-driven attention idioms (e.g. the collapsed corner dot) on rows whose
// status the provider already owns, so a stuck terminal can't light a resting
// run.
export function workspaceHasRunGlyphProvider(workspace: WorkspaceRunGlyphProviderInput): boolean {
  return runGlyphProviderForWorkspace(workspace) !== null
}
