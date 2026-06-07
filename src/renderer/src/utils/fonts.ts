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
