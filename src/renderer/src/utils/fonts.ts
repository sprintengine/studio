// Canonical monospace font stack for JS/canvas surfaces that take a
// `fontFamily` string rather than CSS classes — xterm terminals (TerminalView,
// PlainTerminalPanel) and the Monaco editor (EditorPanel,
// GitConflictResolverPanel). It mirrors the `code, kbd, pre, samp, .font-mono`
// declaration in `src/renderer/src/assets/index.css`; keep the two in sync so
// every mono surface in the app — chrome, code views, and terminals — renders
// in the same typeface. The primary face is JetBrains Mono (loaded via the Google
// Fonts @import in index.css); the rest are platform fallbacks for offline /
// load-failure cases.
export const MONO_FONT_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace'

export const waitForMonoFontReady = async (): Promise<void> => {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  await document.fonts.load(`13px ${MONO_FONT_STACK}`).catch(() => undefined)
  await document.fonts.ready.catch(() => undefined)
}

// Monaco measures its font once per window, caches the widths, and draws the
// caret and the selection by those cached widths rather than by the glyphs the
// browser actually paints. A window that mounts an editor before JetBrains Mono
// has arrived — a freshly opened pop-out editor or diff window, whose web font
// is still downloading when the editor chunk is already there — measures a
// fallback face and keeps those numbers after the real face swaps in. Where the
// fallback is Consolas (Windows) it is about 8% narrower, so by the twelfth
// column a double-clicked word is highlighted a character to the left of where
// it is drawn, and the caret sits a character left of where typing lands.
// Re-measuring once the mono face is ready, and again whenever a later face
// finishes loading, puts the cached widths back on the painted ones. Returns
// the unsubscribe; pass it to the editor's `onDidDispose`.
export const remeasureWhenMonoFontLoads = (remeasure: () => void): (() => void) => {
  if (typeof document === 'undefined' || !('fonts' in document)) return () => undefined
  let disposed = false
  const run = () => {
    if (!disposed) remeasure()
  }
  void waitForMonoFontReady().then(run)
  document.fonts.addEventListener('loadingdone', run)
  return () => {
    disposed = true
    document.fonts.removeEventListener('loadingdone', run)
  }
}
