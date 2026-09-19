import assert from 'node:assert/strict'
import type { TerminalReapEvent } from '../shared/electron-api'
import { clearReapEvents, listRecentReapEvents, MAX_REAP_EVENTS, recordReapEvent } from './terminal-reap-log'
import { test } from 'vitest'

test('terminal-reap-log', async () => {
  function run(name: string, body: () => void): void {
    clearReapEvents()
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function event(overrides: Partial<TerminalReapEvent> = {}): TerminalReapEvent {
    return {
      reapedAt: 1_700_000_000_000,
      reason: 'idle-suspend',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      terminalId: null,
      cli: 'claude-code',
      kind: 'agent',
      idleMs: 3 * 60 * 60 * 1000,
      ...overrides,
    }
  }

  run('records events and lists them most-recent-first', () => {
    recordReapEvent(event({ sessionId: 'a', reapedAt: 1 }))
    recordReapEvent(event({ sessionId: 'b', reapedAt: 2 }))
    recordReapEvent(event({ sessionId: 'c', reapedAt: 3 }))
    assert.deepEqual(
      listRecentReapEvents().map((e) => e.sessionId),
      ['c', 'b', 'a'],
      'newest reap is first',
    )
  })

  run('the buffer is bounded to MAX_REAP_EVENTS, dropping the oldest', () => {
    for (let i = 0; i < MAX_REAP_EVENTS + 50; i += 1) {
      recordReapEvent(event({ sessionId: `s-${i}`, reapedAt: i }))
    }
    const listed = listRecentReapEvents()
    assert.equal(listed.length, MAX_REAP_EVENTS, 'never exceeds the cap')
    assert.equal(listed[0].sessionId, `s-${MAX_REAP_EVENTS + 49}`, 'newest retained')
    assert.equal(listed[listed.length - 1].sessionId, 's-50', 'oldest within the window retained, older dropped')
  })

  run('listRecentReapEvents returns a copy callers cannot mutate', () => {
    recordReapEvent(event({ sessionId: 'a' }))
    const first = listRecentReapEvents()
    first.push(event({ sessionId: 'injected' }))
    assert.deepEqual(
      listRecentReapEvents().map((e) => e.sessionId),
      ['a'],
      'mutating the returned array does not affect the buffer',
    )
  })

  run('both reap reasons round-trip', () => {
    recordReapEvent(event({ sessionId: 'idle', reason: 'idle-suspend', idleMs: 7_200_000 }))
    recordReapEvent(event({ sessionId: 'stale', reason: 'stale-dispose', idleMs: undefined, unseenMs: 86_400_000 }))
    const byId = new Map(listRecentReapEvents().map((e) => [e.sessionId, e]))
    assert.equal(byId.get('idle')?.reason, 'idle-suspend')
    assert.equal(byId.get('stale')?.reason, 'stale-dispose')
    assert.equal(byId.get('stale')?.unseenMs, 86_400_000)
  })

  console.log('terminal-reap-log tests passed')
})
