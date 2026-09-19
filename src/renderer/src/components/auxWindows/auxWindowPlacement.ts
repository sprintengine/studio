import type { AuxWindowKind, WindowBounds } from '../../../../shared/electron-api'

// Auxiliary windows remember their size/position per kind. localStorage is shared
// across every BrowserWindow in the app partition, so the aux window itself
// writes its bounds here and the opener (in another window) reads them back to
// place the next one. Off-screen bounds are re-normalised by the main process.
function placementKey(kind: AuxWindowKind): string {
  return `sprintengine.auxWindowPlacement.${kind}`
}

export function readAuxWindowBounds(kind: AuxWindowKind): WindowBounds | null {
  try {
    const raw = window.localStorage.getItem(placementKey(kind))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WindowBounds>
    const { x, y, width, height } = parsed
    if ([x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return { x: x as number, y: y as number, width: width as number, height: height as number }
    }
    return null
  } catch {
    return null
  }
}

export function writeAuxWindowBounds(kind: AuxWindowKind, bounds: WindowBounds): void {
  try {
    window.localStorage.setItem(placementKey(kind), JSON.stringify(bounds))
  } catch {
    // Persisting placement is best-effort; a quota/serialization failure just
    // means the next window opens at the default size.
  }
}
