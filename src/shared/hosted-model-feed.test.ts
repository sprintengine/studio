import assert from 'node:assert/strict'

import {
  hostedModelAdditions,
  hostedModelFeedUpdatedAtMs,
  hostedModelsByCli,
  isNewHostedModel,
  parseHostedModelFeed,
} from './hosted-model-feed'
import { test } from 'vitest'

test('hosted-model-feed', async () => {
  const valid = {
    schemaVersion: 1,
    updatedAt: '2026-09-04T12:00:00Z',
    clis: {
      'claude-code': {
        models: [
          { id: 'claude-opus-5', label: 'Opus 5', releasedAt: '2026-07-25', retired: false },
          { id: 'opus[1m]', label: 'Opus (latest, 1M context)', alias: true },
          {
            id: 'claude-opus-4-8',
            label: 'Opus 4.8',
            releasedAt: '2026-05-05',
            retired: true,
            retiredAt: '2026-09-01',
          },
        ],
      },
      cursor: { models: [] },
    },
  }

  // A string body parses the same as an object body, unknown fields are dropped,
  // and a missing label falls back to the id so a bare row still renders.
  {
    const parsed = parseHostedModelFeed(JSON.stringify({ ...valid, extra: true }))
    assert.ok(parsed.ok)
    assert.equal(parsed.feed.clis['claude-code'].models.length, 3)
    assert.equal(parsed.feed.clis.cursor.models.length, 0)
    assert.equal(parsed.feed.clis['claude-code'].models[1].alias, true)
    assert.equal(parsed.feed.clis['claude-code'].models[1].releasedAt, undefined, 'an alias floats undated')
    const bare = parseHostedModelFeed({
      schemaVersion: 1,
      updatedAt: '2026-09-04T00:00:00Z',
      clis: { codex: { models: [{ id: ' gpt-5.5 ', releasedAt: '2026-04-23' }] } },
    })
    assert.ok(bare.ok)
    assert.deepEqual(bare.feed.clis.codex.models, [{ id: 'gpt-5.5', label: 'gpt-5.5', releasedAt: '2026-04-23' }])
  }

  // The schema gate: a version this build does not know is refused whole, and so
  // is a missing updatedAt, a duplicate id, a row without an id, or a model
  // without the date it shipped (an alias is the one row that floats undated).
  for (const [label, body] of [
    ['unknown schemaVersion', { ...valid, schemaVersion: 2 }],
    ['missing updatedAt', { schemaVersion: 1, clis: valid.clis }],
    [
      'duplicate id',
      {
        ...valid,
        clis: {
          codex: {
            models: [
              { id: 'a', label: 'A', releasedAt: '2026-01-01' },
              { id: 'a', label: 'A again', releasedAt: '2026-01-01' },
            ],
          },
        },
      },
    ],
    ['model without releasedAt', { ...valid, clis: { codex: { models: [{ id: 'a', label: 'A' }] } } }],
    ['releasedAt not a date', { ...valid, clis: { codex: { models: [{ id: 'a', label: 'A', releasedAt: 'soon' }] } } }],
    ['row without id', { ...valid, clis: { codex: { models: [{ label: 'nameless' }] } } }],
    ['models not an array', { ...valid, clis: { codex: { models: {} } } }],
    ['not json', '{ not json'],
  ] as const) {
    const parsed = parseHostedModelFeed(body)
    assert.equal(parsed.ok, false, `${label} must be rejected`)
  }

  // "New" is releasedAt within 30 days; aliases and retired rows are never new.
  {
    const now = new Date('2026-09-04T00:00:00Z')
    assert.equal(isNewHostedModel({ id: 'a', label: 'A', releasedAt: '2026-08-20' }, now), true)
    assert.equal(isNewHostedModel({ id: 'a', label: 'A', releasedAt: '2026-07-25' }, now), false)
    assert.equal(isNewHostedModel({ id: 'a', label: 'A', releasedAt: '2026-08-20', alias: true }, now), false)
    assert.equal(isNewHostedModel({ id: 'a', label: 'A', releasedAt: '2026-08-20', retired: true }, now), false)
    assert.equal(
      isNewHostedModel({ id: 'a', label: 'A', releasedAt: '2026-09-10' }, now),
      false,
      'a future date is not new yet',
    )
    assert.equal(isNewHostedModel({ id: 'a', label: 'A' }, now), false)
  }

  // updatedAt tie-break and the per-CLI view.
  {
    assert.equal(hostedModelFeedUpdatedAtMs({ updatedAt: '2026-09-04T12:00:00Z' }), Date.parse('2026-09-04T12:00:00Z'))
    assert.equal(hostedModelFeedUpdatedAtMs({ updatedAt: 'nope' }), 0)
    const parsed = parseHostedModelFeed(valid)
    assert.ok(parsed.ok)
    assert.deepEqual(Object.keys(hostedModelsByCli(parsed.feed)), ['claude-code', 'cursor'])
    assert.deepEqual(hostedModelsByCli(null), {})
  }

  // Additions: what the notice names. Retired rows never count, and a first
  // fetch against no previous copy reports every live row.
  {
    const before = parseHostedModelFeed(valid)
    assert.ok(before.ok)
    const after = parseHostedModelFeed({
      ...valid,
      updatedAt: '2026-09-05T00:00:00Z',
      clis: {
        'claude-code': {
          models: [
            ...valid.clis['claude-code'].models,
            { id: 'claude-fable-5-1', label: 'Fable 5.1', releasedAt: '2026-09-04' },
            {
              id: 'claude-opus-4-7',
              label: 'Opus 4.7',
              releasedAt: '2026-03-03',
              retired: true,
              retiredAt: '2026-09-05',
            },
          ],
        },
        codex: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', releasedAt: '2026-07-09' }] },
      },
    })
    assert.ok(after.ok)
    const added = hostedModelAdditions(before.feed, after.feed)
    assert.deepEqual(Object.keys(added), ['claude-code', 'codex'])
    assert.deepEqual(
      added['claude-code'].map((model) => model.id),
      ['claude-fable-5-1'],
    )
    assert.deepEqual(
      added.codex.map((model) => model.id),
      ['gpt-5.6-sol'],
    )
    assert.deepEqual(Object.keys(hostedModelAdditions(after.feed, after.feed)), [])
    assert.deepEqual(
      hostedModelAdditions(null, before.feed)['claude-code'].map((model) => model.id),
      ['claude-opus-5', 'opus[1m]'],
    )
  }

  console.log('hosted-model-feed: ok')
})
