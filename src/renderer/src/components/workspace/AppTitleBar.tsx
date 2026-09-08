

// The native traffic lights are pinned at y:11 by the hiddenInset frame
// (window-factory.ts), so the strip stays 36px to keep them vertically
// centered; the slimming comes from dropping the brand, not the height.
// Exported so the aux-window strips (ExternalEditorWindow / DiffViewerWindow)
// share the exact height/inset instead of re-hardcoding the literals.
export const TITLE_BAR_HEIGHT = 'h-[36px]'
// The same measure as a number, for the places that need it in a style rather
// than a class (the app rail's divider starts at it). Tailwind only generates
// an arbitrary value it can read as literal source text, so the class above
// cannot be built from this — keep the two in step by hand.
export const TITLE_BAR_HEIGHT_PX = 36

// macOS reserves the leftmost slice for the native traffic lights; pad the nav
// flow past them so nothing sits under the close/zoom buttons. Dropped when the
// window is fullscreen on macOS, where the lights are hidden.
export const TRAFFIC_LIGHT_INSET = 'pl-[78px]'
