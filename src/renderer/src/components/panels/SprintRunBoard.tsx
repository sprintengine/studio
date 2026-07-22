// Door-facing entry point for the sprint run board. The Sprints door surface
// (T4) imports the board and its statePath handle plumbing from here, so it
// never depends on the workspace-prop adapter (`SprintEngineBoardPanel`'s
// default export). The board component itself lives in SprintEngineBoardPanel.tsx
// alongside the workspace adapter; this module re-exports it together with the
// run-handle helpers so a door canvas has a single import site:
//
//   const handle = useSprintRunHandleFromStatePath(statePath, teamSlug)
//   return handle ? <SprintRunBoard handle={handle} /> : <loading/error from useSprintRunEntry>
//
export { SprintRunBoard } from './SprintEngineBoardPanel'
export {
  useSprintRunHandleFromStatePath,
  useSprintRunEntry,
  useSprintRunStore,
  sprintRunHandleFromWorkspace,
  normalizeStatePathKey,
  type SprintRunHandle,
  type SprintRunEntry,
} from '../../store/sprintRunStoreSlice'
