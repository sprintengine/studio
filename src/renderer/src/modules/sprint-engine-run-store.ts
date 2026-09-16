import { create } from 'zustand'

import type { AppSettings, Workspace } from '../types/workspace'
import { createRunStateSlice, type RunStateSlice } from './sprint-engine-run-state'

// Module-owned live run store (MC-2573). The actions still mutate the
// workspace row — durable identity and the live projection live in the
// sprintengine bag, and auto-state is session-only on the workspace — but
// they are no longer members of the core workspace store. The shell's
// panels and supervisors subscribe here.
//
// Live run state is not persisted (partialize strips the bag's `state`),
// so this store is a bound action surface rather than a second copy of
// the projection. Readers keep using `sprintEngineRunState` on the bag;
// writers go through these actions so the core store has no Sprint Engine
// run mutators.
//
// The shell binds the workspace-store setter (MC-2577). This module does
// not import the core store — a private-hook reach the epic forbids.

type RunStateCarrier = { workspaces: Workspace[]; appSettings?: AppSettings }

export type SprintEngineRunStoreApplier = (recipe: (state: RunStateCarrier) => void) => void

let applyWorkspaceState: SprintEngineRunStoreApplier | null = null

export function bindSprintEngineRunStore(apply: SprintEngineRunStoreApplier): void {
  applyWorkspaceState = apply
}

export const useSprintEngineRunStore = create<RunStateSlice>()(() =>
  createRunStateSlice((recipe) => {
    if (!applyWorkspaceState) {
      throw new Error('Sprint Engine run store is not bound — the shell must call bindSprintEngineRunStore.')
    }
    applyWorkspaceState(recipe)
  }),
)
