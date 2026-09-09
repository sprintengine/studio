// Pure helper: a 1–2 letter uppercase monogram fallback for a plugin/server when
// no icon is available. Kept in its own component-free module so non-Settings
// surfaces (e.g. the first-run extensions teaser) can reuse it without importing
// the Settings component graph.
export function mcpMonogram(name: string): string {
  // Words are split on anything that is not a letter or digit, not on
  // whitespace alone: the marketplace names things `claude-security` and
  // `42crunch-api-security-testing`, and a monogram that read those as one
  // word gave every hyphenated row a single letter (extensions review,
  // 2026-09-08). One word takes its first two letters, so `access` is AC and
  // not a lone A.
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return ''
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`
  return letters.toUpperCase()
}
