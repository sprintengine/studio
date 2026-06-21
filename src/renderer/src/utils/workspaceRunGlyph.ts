import { getRendererHost, selectModuleEnabled } from '../modules'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace } from '../types/workspace'
import type { LifecycleState } from '../components/ui/LifecycleGlyph'

// Mode-level status for a sidebar workspace row, expressed in the shared
// lifecycle vocabulary. This module is the per-mode dispatch point: a
// workspace's status is owned by the module that owns its workspace type, and
// the shell only consumes the derived glyph.
export type WorkspaceRunGlyph = { state: LifecycleState; live: boolean; label: string }

// Matches the shell's terminal-derived activity vocabulary
// (workspaceManagerHelpers.WorkspaceActivity) without importing across the
// utils → components boundary.
export type WorkspaceActivityKind = 'needs-input' | 'working' | 'failed' | 'idle'

export type WorkspaceRunGlyphProviderInput = Pick<
  Workspace,
  'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState'
>

function isModuleEnabledForRunGlyph(moduleId: string): boolean {
  return selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId)
}

function runGlyphProviderForWorkspace(workspace: WorkspaceRunGlyphProviderInput) {
  return getRendererHost().getWorkspaceTypes(isModuleEnabledForRunGlyph).find((definition) => {
    if (!definition.deriveRunGlyph) return false
    return definition.isRunGlyphProviderForWorkspace?.(workspace) ?? definition.id === workspace.mode
  }) ?? null
}

// The sidebar row's one status slot. Priority mirrors the attention order the
// dot system had, upgraded to the lifecycle vocabulary:
//   1. An agent terminal waiting on input (the old pulsing warn dot) — always
//      the actionable signal, even while the runner reports `running`.
//   2. The run rollup (human-routed needs_input, runner runtime states).
//   3. Terminal activity: busy terminals spin, a failed terminal reads as
//      failed — one idiom, no `now` text on provider-owned rows. This
//      outranks a finished run: new activity reads as live again.
//   4. A newly completed run — runner `complete` or a manually-driven run
//      whose tasks all finished — wears `done` until the user views the
//      workspace after completion. Recency survives in the tooltip and becomes
//      the row fallback after acknowledgement.
// Null means "no run signal": the caller falls back to recency text.
export function deriveWorkspaceRunGlyph(
  workspace: WorkspaceRunGlyphProviderInput,
  activity: WorkspaceActivityKind,
): WorkspaceRunGlyph | null {
  const provider = runGlyphProviderForWorkspace(workspace)
  if (!provider) return null

  if (activity === 'needs-input') {
    return { state: 'needs_input', live: false, label: 'Needs input' }
  }

  const providerGlyph = provider.deriveRunGlyph?.(workspace, activity) ?? null
  if (providerGlyph) return providerGlyph

  if (activity === 'working') {
    return { state: 'in_progress', live: true, label: 'Agents working' }
  }
  if (activity === 'failed') {
    return { state: 'failed', live: false, label: 'Agent failed' }
  }
  return null
}
