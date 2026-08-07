// Pure helper: a 1–2 letter uppercase monogram fallback for a plugin/server when
// no icon is available. Kept in its own component-free module so non-Settings
// surfaces (e.g. the first-run extensions teaser) can reuse it without importing
// the Settings component graph.
export function mcpMonogram(name: string): string {
  return name
    .split(/\s+/u)
    .map((piece) => piece[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}
