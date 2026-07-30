import { useWorkspaceStore } from '../../../store/workspaceStore'

// The back affordance shared by every door surface (mockup #view-doors): leaving a
// door means leaving the door, which is exactly what `closeGlobalSurface` does —
// never NavHistory, which would walk to wherever the operator happened to be
// before rather than out of the page they are on.
//
// `canGoBack` is unconditionally true because there is always somewhere to land:
// the workspace the door was opened over, or — with no workspace open — the
// workspace rail and its empty state. It used to gate on `activeWorkspaceId`, and
// that gate was a dead end in exactly the state that needs a way out most: a
// first-run profile with no project open showed a door with no back affordance at
// all. Item 1993 makes this louder still, since a door with a rail hides the rows
// you would otherwise have escaped through.
//
// Kept out of `surfaceSubstrate.tsx` so the pure presentational primitives there
// (SurfaceCanvasState / SurfaceRail / BarStatusChip) stay free of the workspace
// store's transitive imports and remain unit-testable as bare markup.
export function useSurfaceBackNav(): { onBack: () => void; canGoBack: boolean } {
  const onBack = useWorkspaceStore((state) => state.closeGlobalSurface)
  return { onBack, canGoBack: true }
}
