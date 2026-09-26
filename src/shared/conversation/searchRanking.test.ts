import { expect, test } from 'vitest'
import { mentionMatchTier, rankMentionCandidates } from './searchRanking'

test('mention ranking uses explicit basename, path and subsequence tiers', () => {
  expect(
    ['src/app', 'src/application.ts', 'src/my-app.ts', 'app/other.ts', 'src/a-long-patch-page.ts'].map((path) =>
      mentionMatchTier(path, 'app'),
    ),
  ).toEqual([5, 4, 3, 2, 1])
  expect(mentionMatchTier('src/myApp.ts', 'app')).toBe(3)
  expect(mentionMatchTier('src/unrelated.ts', 'zzz')).toBe(0)
  const paths = ['app/other.ts', 'src/my-app.ts', 'src/application.ts', 'src/app']
  expect(
    rankMentionCandidates(
      paths.map((path) => ({ path, kind: 'file' as const })),
      'app',
    ).map((entry) => entry.path),
  ).toEqual(paths.reverse())
})
test('ties prefer shorter paths then recently opened files and are capped', () => {
  const candidates = [
    { path: 'ab/app', kind: 'file' as const, recentAt: 20 },
    { path: 'a/app', kind: 'file' as const, recentAt: 1 },
    { path: 'cd/app', kind: 'file' as const, recentAt: 30 },
  ]
  expect(rankMentionCandidates(candidates, 'app').map((entry) => entry.path)).toEqual(['a/app', 'cd/app', 'ab/app'])
  expect(rankMentionCandidates(candidates, 'app', 1)).toHaveLength(1)
})
