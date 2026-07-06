// Sprint Engine inspector pane width — clamp + localStorage persistence for
// the drag-resizable right aside. Kept in one module so the panel wiring and
// the drag math can never disagree (same pattern as workspace/sidebarWidth.ts).

// Bounds for the dragged width. The minimum matches SidePane's preset minimum;
// the maximum allows a genuinely roomy reading pane without swallowing the
// board on common window sizes.
export const INSPECTOR_PANE_MIN_WIDTH = 320
export const INSPECTOR_PANE_MAX_WIDTH = 760

const STORAGE_KEY = 'multicode.sprintEngine.inspectorWidth'

// Clamp an arbitrary dragged width into the allowed range.
export function clampInspectorPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_PANE_MIN_WIDTH
  return Math.min(INSPECTOR_PANE_MAX_WIDTH, Math.max(INSPECTOR_PANE_MIN_WIDTH, Math.round(width)))
}

// null → no stored width; the pane uses its responsive preset (42%).
export function loadInspectorPaneWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampInspectorPaneWidth(parsed) : null
  } catch {
    return null
  }
}

export function saveInspectorPaneWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(clampInspectorPaneWidth(width)))
  } catch {
    // Persistence is best-effort; the in-session width still applies.
  }
}
