import { create } from 'zustand'

import { useWorkspaceStore } from '../store/workspaceStore'
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
export const useSprintEngineRunStore = create<RunStateSlice>()(() =>
  createRunStateSlice((recipe) => {
    useWorkspaceStore.setState(recipe as never)
  }),
)
