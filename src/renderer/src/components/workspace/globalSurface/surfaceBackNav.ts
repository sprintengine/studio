import { useWorkspaceStore } from '../../../store/workspaceStore'

// The back affordance shared by every door surface (mockup #view-doors): returning
// from a door goes back to the workspace it was opened over, which is exactly what
// `closeGlobalSurface` does. `canGoBack` is true whenever there is such a location
// to return to, so the bar chevron shows only when it leads somewhere — never a
// dead control on a door with nothing underneath it.
//
// Kept out of `surfaceSubstrate.tsx` so the pure presentational primitives there
// (SurfaceCanvasState / SurfaceRail / BarStatusChip) stay free of the workspace
// store's transitive imports and remain unit-testable as bare markup.
export function useSurfaceBackNav(): { onBack: () => void; canGoBack: boolean } {
  const onBack = useWorkspaceStore((state) => state.closeGlobalSurface)
  const canGoBack = useWorkspaceStore((state) => state.activeWorkspaceId !== null)
  return { onBack, canGoBack }
}
