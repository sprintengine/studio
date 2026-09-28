import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { AgentGlyph } from './AgentGlyph'
import { AGENT_CHARACTERS } from './agentGlyph/characters'
import { AGENT_SEASON_POOLS, pickAgentCharacter, seasonFor } from './agentGlyph/seasons'
import { WORKING_MARK_VARIANTS, WorkingMark } from './WorkingMark'

const localDate = (month: number, day: number) => new Date(2026, month - 1, day, 12)

test('the season follows the local calendar', () => {
  assert.equal(seasonFor(localDate(9, 28)), 'everyday')
  assert.equal(seasonFor(localDate(10, 1)), 'halloween')
  assert.equal(seasonFor(localDate(10, 31)), 'halloween')
  assert.equal(seasonFor(localDate(11, 1)), 'everyday')
  assert.equal(seasonFor(localDate(12, 1)), 'christmas')
  assert.equal(seasonFor(localDate(12, 26)), 'christmas')
  assert.equal(seasonFor(localDate(12, 27)), 'everyday')
})

test('every season has at least three characters, the robot among them, all drawn', () => {
  for (const [season, pool] of Object.entries(AGENT_SEASON_POOLS)) {
    assert.ok(pool.length >= 3, `${season} has ${pool.length}`)
    assert.ok(pool.includes('robot'), `${season} has the robot`)
    for (const id of pool) assert.ok(AGENT_CHARACTERS[id], `${id} is drawn`)
  }
})

test('an agent keeps its character, and agents spread across the pool', () => {
  const october = localDate(10, 20)
  assert.equal(pickAgentCharacter('toolu_01abc', october), pickAgentCharacter('toolu_01abc', october))
  const picked = new Set(Array.from({ length: 40 }, (_, index) => pickAgentCharacter(`toolu_${index}`, october)))
  assert.deepEqual([...picked].sort(), [...AGENT_SEASON_POOLS.halloween].sort())
  assert.ok(AGENT_SEASON_POOLS.christmas.includes(pickAgentCharacter('toolu_01abc', localDate(12, 18))))
})

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  })
})
afterEach(() => vi.unstubAllGlobals())

test('a season can be previewed without changing the clock', () => {
  localStorage.setItem('sprintengine.agentSeason', 'christmas')
  assert.ok(AGENT_SEASON_POOLS.christmas.includes(pickAgentCharacter('toolu_01abc', localDate(3, 3))))
  localStorage.setItem('sprintengine.agentSeason', 'spring')
  assert.ok(
    AGENT_SEASON_POOLS.everyday.includes(pickAgentCharacter('toolu_01abc', localDate(3, 3))),
    'unknown is ignored',
  )
})

test('a working character moves; a finished one stands still with the face its end earned', () => {
  const draw = (state: 'working' | 'done' | 'failed' | 'stopped') =>
    renderToStaticMarkup(createElement(AgentGlyph, { agentId: 'a', state, character: 'robot' }))
  const working = draw('working')
  assert.match(working, /agent-glyph--working/)
  assert.match(working, /agent-glyph__whole/, 'the parts that move are wrapped for their keyframes')
  assert.match(working, /agent-glyph__eyes/)
  for (const state of ['done', 'failed', 'stopped'] as const) {
    const markup = draw(state)
    assert.doesNotMatch(markup, /agent-glyph__/, `${state} has nothing that moves`)
    assert.match(markup, new RegExp(`agent-glyph--${state}`))
  }
  assert.match(draw('failed'), /--tone-error/)
  assert.match(draw('working'), /--accent-primary/)
})

test('a glyph is decorative unless it is given a name', () => {
  assert.match(renderToStaticMarkup(createElement(AgentGlyph, { agentId: 'a', state: 'done' })), /aria-hidden="true"/)
  const named = renderToStaticMarkup(
    createElement(AgentGlyph, { agentId: 'a', state: 'working', label: 'Explore agent working' }),
  )
  assert.match(named, /role="img"/)
  assert.match(named, /aria-label="Explore agent working"/)
})

test('every character draws in every state', () => {
  for (const character of Object.keys(AGENT_CHARACTERS) as Array<keyof typeof AGENT_CHARACTERS>)
    for (const state of ['working', 'done', 'failed', 'stopped', 'unknown'] as const)
      assert.match(
        renderToStaticMarkup(createElement(AgentGlyph, { agentId: 'a', state, character })),
        new RegExp(`data-character="${character}"`),
      )
})

test('a chat keeps its working mark, and chats spread across the four', () => {
  const variantOf = (seed: string) =>
    /data-variant="(\w+)"/.exec(renderToStaticMarkup(createElement(WorkingMark, { label: 'Agent working', seed })))?.[1]
  assert.equal(variantOf('agent-1'), variantOf('agent-1'))
  const seen = new Set(Array.from({ length: 40 }, (_, index) => variantOf(`agent-${index}`)))
  assert.deepEqual([...seen].sort(), [...WORKING_MARK_VARIANTS].sort())
})

test('a working mark is nine cells named by its label; the edge patterns hold the centre still', () => {
  const markup = renderToStaticMarkup(createElement(WorkingMark, { label: 'Searching', variant: 'orbit' }))
  assert.match(markup, /role="img"/)
  assert.match(markup, /aria-label="Searching"/)
  assert.equal(markup.match(/<i /g)?.length, 9)
  assert.equal(markup.match(/working-mark__cell--still/g)?.length, 1)
  assert.equal(
    renderToStaticMarkup(createElement(WorkingMark, { label: 'x', variant: 'ripple' })).includes('--still'),
    false,
  )
})
