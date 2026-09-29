import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  PROMPT_CACHE_NOTICE_TOKENS,
  promptCacheCopy,
  promptCacheNeedsAttention,
  promptCacheNoticeLine,
  promptCacheState,
} from './promptCacheState'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

test('a cache reads warm, then expiring in its last minutes, then cold', () => {
  const hour = (left: number) => ({ ttl: '1h' as const, expiresAt: NOW + left, recacheTokens: 310_000 })
  assert.equal(promptCacheState(hour(42 * MINUTE), NOW)?.kind, 'warm')
  assert.equal(promptCacheState(hour(10 * MINUTE), NOW)?.kind, 'expiring', 'an hour cache has ten minutes of warning')
  assert.equal(promptCacheState(hour(0), NOW)?.kind, 'cold', 'gone at its expiry, not a moment after')
  // A five-minute cache is "expiring" for only its last two minutes, or it
  // would be for most of its life.
  const five = (left: number) => ({ ttl: '5m' as const, expiresAt: NOW + left, recacheTokens: 310_000 })
  assert.equal(promptCacheState(five(4 * MINUTE), NOW)?.kind, 'warm')
  assert.equal(promptCacheState(five(2 * MINUTE), NOW)?.kind, 'expiring')
  // Nothing cached at all is cold, with no moment it expired.
  assert.deepEqual(promptCacheState({ ttl: null, expiresAt: null, recacheTokens: 5 }, NOW), {
    kind: 'cold',
    expiredAt: null,
    recacheTokens: 5,
  })
  assert.equal(promptCacheState(null, NOW), null)
})

test('only a big conversation’s cache going or gone is worth a mark', () => {
  const big = { ttl: '1h' as const, expiresAt: NOW + 5 * MINUTE, recacheTokens: PROMPT_CACHE_NOTICE_TOKENS }
  assert.equal(promptCacheNeedsAttention(promptCacheState(big, NOW)), true)
  assert.equal(promptCacheNeedsAttention(promptCacheState({ ...big, expiresAt: NOW - MINUTE }, NOW)), true)
  assert.equal(
    promptCacheNeedsAttention(promptCacheState({ ...big, expiresAt: NOW + 30 * MINUTE }, NOW)),
    false,
    'warm',
  )
  assert.equal(
    promptCacheNeedsAttention(promptCacheState({ ...big, recacheTokens: PROMPT_CACHE_NOTICE_TOKENS - 1 }, NOW)),
    false,
    'a short chat re-caches cheaply',
  )
  assert.equal(
    promptCacheNeedsAttention(promptCacheState({ ...big, recacheTokens: null }, NOW)),
    false,
    'a size not reported yet (right after a compaction) is not assumed big',
  )
})

test('the words say what the next message costs and what compacting buys', () => {
  const expiring = promptCacheState({ ttl: '1h', expiresAt: NOW + 8 * MINUTE, recacheTokens: 310_200 }, NOW)!
  assert.deepEqual(promptCacheCopy(expiring, NOW), {
    label: 'Cache expires in 8m',
    detail:
      'After that, the next message re-sends ~310k tokens uncached. Compacting now, while the cache is warm, is cheap.',
  })
  const cold = promptCacheState({ ttl: '1h', expiresAt: NOW - 2 * 60 * MINUTE, recacheTokens: 310_200 }, NOW)!
  assert.equal(promptCacheCopy(cold, NOW).label, 'Cache expired 2h ago')
  assert.match(promptCacheCopy(cold, NOW).detail, /re-sends ~310k tokens uncached, a compaction included/)
  assert.equal(
    promptCacheCopy(promptCacheState({ ttl: null, expiresAt: null, recacheTokens: null }, NOW)!, NOW).label,
    'Cache cold',
  )
  const warm = promptCacheState({ ttl: '1h', expiresAt: NOW + 42 * MINUTE, recacheTokens: 1 }, NOW)!
  assert.equal(promptCacheCopy(warm, NOW).label, 'Cache warm · 42m left')
  const lastSeconds = promptCacheState({ ttl: '5m', expiresAt: NOW + 20_000, recacheTokens: 1 }, NOW)!
  assert.equal(promptCacheCopy(lastSeconds, NOW).label, 'Cache expires in under a minute')
})

test('the composer line says when the cache goes, and how many tokens are cached or already uncached', () => {
  const expiring = promptCacheState({ ttl: '5m', expiresAt: NOW + 2 * MINUTE, recacheTokens: 198_400 }, NOW)
  assert.ok(promptCacheNeedsAttention(expiring))
  assert.equal(promptCacheNoticeLine(expiring, NOW), 'Cache expires in 2m · ~198k tokens cached')
  const cold = promptCacheState({ ttl: '5m', expiresAt: NOW - 13 * MINUTE, recacheTokens: 198_400 }, NOW)
  assert.ok(promptCacheNeedsAttention(cold))
  assert.equal(promptCacheNoticeLine(cold, NOW), 'Cache expired 13m ago · ~198k tokens uncached')
})
