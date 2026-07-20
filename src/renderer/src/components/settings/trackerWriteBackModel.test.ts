import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TrackerCapabilities, TrackerWriteBackConfig } from '../../../../shared/electron-api'
import {
  COMMENT_EVENTS,
  masterDescription,
  previewComments,
  providerDisplayName,
  renderCommentBlocks,
  showsTransitionTier,
  TRANSITION_EVENTS,
  transitionSelectOptions,
} from './trackerWriteBackModel'

function config(overrides: Partial<TrackerWriteBackConfig> = {}): TrackerWriteBackConfig {
  return {
    enabled: true,
    comments: { started: true, pr: true, done: true },
    transitions: { onStart: null, onComplete: null },
    ...overrides,
  }
}

function caps(overrides: Partial<TrackerCapabilities> = {}): TrackerCapabilities {
  return { canComment: true, canTransition: false, selfHostable: false, ...overrides }
}

test('masterDescription names the provider when off and the ticked-only contract when on', () => {
  assert.equal(masterDescription(false, 'jira'), 'Off — sprints read from Jira but never write to it.')
  assert.equal(masterDescription(false, 'github'), 'Off — sprints read from GitHub but never write to it.')
  assert.equal(masterDescription(true, 'jira'), 'On — only the events ticked below are posted.')
})

test('providerDisplayName falls back to a neutral word for an unknown provider', () => {
  assert.equal(providerDisplayName('linear'), 'Linear')
  // @ts-expect-error — exercising the defensive fallback path
  assert.equal(providerDisplayName('gitlab'), 'the tracker')
})

test('event catalogs match the mockup order and count', () => {
  assert.deepEqual(
    COMMENT_EVENTS.map((e) => e.key),
    ['started', 'pr', 'done'],
  )
  assert.deepEqual(
    TRANSITION_EVENTS.map((e) => e.key),
    ['onStart', 'onComplete'],
  )
})

test('showsTransitionTier is capability-driven, never a provider check', () => {
  assert.equal(showsTransitionTier(caps({ canTransition: true })), true)
  assert.equal(showsTransitionTier(caps({ canTransition: false })), false)
  assert.equal(showsTransitionTier(undefined), false)
})

test('transitionSelectOptions leads with the null mapping and maps real transitions', () => {
  const options = transitionSelectOptions([
    { id: '31', name: 'In Progress' },
    { id: '41', name: 'Done' },
  ])
  assert.equal(options[0].value, '')
  assert.match(options[0].label, /Don’t change status/)
  assert.deepEqual(options.slice(1), [
    { value: '31', label: 'Move to “In Progress”' },
    { value: '41', label: 'Move to “Done”' },
  ])
})

test('previewComments is empty when the master switch is off', () => {
  assert.deepEqual(previewComments(config({ enabled: false })), [])
})

test('previewComments reflects exactly the ticked events, in lifecycle order', () => {
  const only = previewComments(config({ comments: { started: false, pr: true, done: false } }))
  assert.deepEqual(
    only.map((c) => c.key),
    ['pr'],
  )
  const all = previewComments(config())
  assert.deepEqual(
    all.map((c) => c.key),
    ['started', 'pr', 'done'],
  )
})

test('previewComments bodies are the real engine-composed comments, not placeholders', () => {
  const [started] = previewComments(config({ comments: { started: true, pr: false, done: false } }))
  // Must match the shared writeback-messages wording the engine posts verbatim.
  assert.match(started.markdown, /\*\*Sprint started\*\* in Multicode\./)
  assert.match(started.markdown, /posted automatically by Multicode/)
})

test('renderCommentBlocks tokenizes bold headline and a url list', () => {
  const blocks = renderCommentBlocks('**Pull request opened** for this sprint.\n\n- https://example.test/pr/1')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].kind, 'paragraph')
  if (blocks[0].kind === 'paragraph') {
    assert.equal(blocks[0].segments[0].bold, true)
    assert.equal(blocks[0].segments[0].text, 'Pull request opened')
    assert.equal(blocks[0].segments[1].bold, undefined)
  }
  assert.equal(blocks[1].kind, 'link-list')
  if (blocks[1].kind === 'link-list') {
    assert.deepEqual(blocks[1].urls, ['https://example.test/pr/1'])
  }
})

test('renderCommentBlocks keeps unbalanced markers as literal text', () => {
  const blocks = renderCommentBlocks('Working on: **half open')
  assert.equal(blocks.length, 1)
  if (blocks[0].kind === 'paragraph') {
    assert.equal(blocks[0].segments.map((s) => s.text).join(''), 'Working on: **half open')
    assert.ok(blocks[0].segments.every((s) => !s.bold))
  }
})
