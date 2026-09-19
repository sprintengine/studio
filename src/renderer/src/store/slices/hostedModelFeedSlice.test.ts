import assert from 'node:assert/strict'

import type { HostedModelFeedReadResult } from '../../../../shared/electron-api'
import {
  createHostedModelFeedSlice,
  subscribeHostedModelFeedChanges,
  type HostedModelFeedSliceState,
} from './hostedModelFeedSlice'
import { test } from 'vitest'

test('hostedModelFeedSlice', async () => {
  const feed = (ids: string[]) => ({
    schemaVersion: 1 as const,
    updatedAt: '2026-09-04T00:00:00Z',
    clis: { 'claude-code': { models: ids.map((id) => ({ id, label: id })) } },
  })

  const okResult = (
    ids: string[],
    source: 'network' | 'cache' | 'seed',
    changed: boolean,
  ): HostedModelFeedReadResult => ({
    ok: true,
    state: 'ok',
    feedUrl: 'https://example.com/model-feed.json',
    source,
    fetchedAt: '2026-09-04T12:00:00Z',
    changed,
    feed: feed(ids),
  })

  async function main(): Promise<void> {
    const carrier: HostedModelFeedSliceState = { hostedModelFeed: null, hostedModelCatalogs: {} }
    const calls: string[] = []
    const slice = createHostedModelFeedSlice((mutator) => mutator(carrier), {
      getApi: () => ({
        hostedModelFeedGet: async () => {
          calls.push('get')
          return okResult(['seeded'], 'seed', false)
        },
        hostedModelFeedRefresh: async (input) => {
          calls.push(`refresh:${input?.forceRefresh ? 'force' : 'ttl'}`)
          return okResult(['seeded', 'claude-fable-5-1'], 'network', true)
        },
      }),
    })

    // Boot serves the disk copy and splits it per CLI for the merge.
    await slice.loadHostedModelFeed()
    assert.deepEqual(calls, ['get'])
    assert.deepEqual(
      carrier.hostedModelCatalogs['claude-code']?.map((m) => m.id),
      ['seeded'],
    )
    assert.equal(carrier.hostedModelFeed?.ok && carrier.hostedModelFeed.source, 'seed')

    // Check now forces; the result is applied here without waiting for the push.
    const refreshed = await slice.refreshHostedModelFeed({ force: true })
    assert.equal(refreshed?.ok, true)
    assert.deepEqual(calls, ['get', 'refresh:force'])
    assert.deepEqual(
      carrier.hostedModelCatalogs['claude-code']?.map((m) => m.id),
      ['seeded', 'claude-fable-5-1'],
    )

    // A failure keeps the rows that were showing and records the failure.
    slice.applyHostedModelFeedResult({ ok: false, state: 'offline', feedUrl: 'x', message: "Couldn't reach GitHub." })
    assert.deepEqual(
      carrier.hostedModelCatalogs['claude-code']?.map((m) => m.id),
      ['seeded', 'claude-fable-5-1'],
    )
    assert.equal(carrier.hostedModelFeed?.ok, false)

    // The push subscription applies whatever main sends.
    // A holder, not a bare `let`: the subscription hands the callback back from
    // inside another callback, and flow analysis would keep reading a `let` as
    // its initializer.
    const push: { fn: ((result: HostedModelFeedReadResult) => void) | null } = { fn: null }
    const unsubscribe = subscribeHostedModelFeedChanges(slice.applyHostedModelFeedResult, {
      onHostedModelFeedChanged: (cb) => {
        push.fn = cb
        return () => {
          push.fn = null
        }
      },
    })
    assert.ok(push.fn)
    push.fn(okResult(['only-this'], 'network', true))
    assert.deepEqual(
      carrier.hostedModelCatalogs['claude-code']?.map((m) => m.id),
      ['only-this'],
    )
    unsubscribe()
    assert.equal(push.fn, null)

    // No api (a test renderer, a detached tool window) is a quiet no-op.
    const bare = createHostedModelFeedSlice((mutator) => mutator(carrier), { getApi: () => null })
    await bare.loadHostedModelFeed()
    assert.equal(await bare.refreshHostedModelFeed(), null)
    assert.equal(subscribeHostedModelFeedChanges(() => {}, null)(), undefined)

    console.log('hostedModelFeedSlice: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
