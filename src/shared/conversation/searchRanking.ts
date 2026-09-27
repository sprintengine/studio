export type MentionCandidate = { path: string; kind: 'file' | 'folder'; recentAt?: number }
export function mentionMatchTier(path: string, query: string): number {
  const original = path.replaceAll('\\', '/').replace(/\/$/u, '')
  const normalized = original.toLocaleLowerCase(),
    needle = query.trim().toLocaleLowerCase()
  if (!needle) return 1
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const originalName = original.slice(original.lastIndexOf('/') + 1)
  if (name === needle) return 5
  if (name.startsWith(needle)) return 4
  for (let index = name.indexOf(needle); index >= 0; index = name.indexOf(needle, index + 1)) {
    if (
      index === 0 ||
      /[\s._-]/u.test(originalName[index - 1]) ||
      (/[a-z]/u.test(originalName[index - 1]) && /[A-Z]/u.test(originalName[index]))
    )
      return 3
  }
  if (normalized.includes(needle)) return 2
  let next = 0
  for (const character of normalized) if (character === needle[next]) next++
  return next === needle.length ? 1 : 0
}
export function rankMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit = 50,
): T[] {
  return candidates
    .map((candidate) => ({ candidate, tier: mentionMatchTier(candidate.path, query) }))
    .filter((entry) => entry.tier > 0)
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        a.candidate.path.length - b.candidate.path.length ||
        (b.candidate.recentAt ?? 0) - (a.candidate.recentAt ?? 0) ||
        a.candidate.path.localeCompare(b.candidate.path),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.candidate)
}
