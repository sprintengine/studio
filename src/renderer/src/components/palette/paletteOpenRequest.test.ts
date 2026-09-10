// The star → shell seam. It is four lines of `CustomEvent`, which is exactly
// why it is worth pinning: the two things that go wrong with a window event are
// a listener that is added twice and never removed, and a request that arrives
// before anyone is listening. Both are answered here rather than in a comment.

import assert from 'node:assert/strict'

import { requestPaletteOpen, subscribePaletteOpenRequest, type PaletteOpenRequest } from './paletteOpenRequest'

let failures = 0
function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// A bare `EventTarget` is the whole surface both halves use — `addEventListener`,
// `removeEventListener`, `dispatchEvent` — so the seam runs unmodified with no DOM.
function fakeWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = new EventTarget()
}

run('the request reaches the shell with its scope and its pane', () => {
  fakeWindow()
  const seen: PaletteOpenRequest[] = []
  const stop = subscribePaletteOpenRequest((request) => seen.push(request))
  requestPaletteOpen({ scope: 'extensions', target: { sessionId: 'session-1', cli: 'claude-code', workspaceId: 'ws-1' } })
  stop()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].scope, 'extensions')
  assert.deepEqual(seen[0].target, { sessionId: 'session-1', cli: 'claude-code', workspaceId: 'ws-1' })
})

run('unsubscribing removes the listener, so a remounted shell does not stack them', () => {
  fakeWindow()
  let calls = 0
  // What a re-render does when the effect's deps change: unsubscribe, resubscribe.
  const first = subscribePaletteOpenRequest(() => {
    calls += 1
  })
  first()
  const second = subscribePaletteOpenRequest(() => {
    calls += 1
  })
  requestPaletteOpen({ scope: 'all' })
  second()
  assert.equal(calls, 1, 'the released subscription must not still be answering')
  requestPaletteOpen({ scope: 'all' })
  assert.equal(calls, 1, 'and nothing answers once the shell has let go')
})

run('a request nobody is listening for is dropped, not queued', () => {
  fakeWindow()
  // There is no latch on purpose: the shell mounts before any pane that could
  // ask, so a request can only be early if there is no shell to serve it.
  requestPaletteOpen({ scope: 'extensions', target: { sessionId: 'gone' } })
  const seen: PaletteOpenRequest[] = []
  const stop = subscribePaletteOpenRequest((request) => seen.push(request))
  stop()
  assert.deepEqual(seen, [], 'a late subscriber must not be handed a stale pane to aim at')
})

run('every subscriber hears every request, so two shells in one window would both open', () => {
  fakeWindow()
  const heard: string[] = []
  const a = subscribePaletteOpenRequest(() => heard.push('a'))
  const b = subscribePaletteOpenRequest(() => heard.push('b'))
  requestPaletteOpen({ scope: 'all' })
  a()
  b()
  // Not a defect — it is the reason the shell subscribes once, with `[]` deps,
  // and the reason this asserts the fan-out rather than assuming one listener.
  assert.deepEqual(heard, ['a', 'b'])
})

run('the palette a keyboard raised belongs to no pane', () => {
  fakeWindow()
  const seen: PaletteOpenRequest[] = []
  const stop = subscribePaletteOpenRequest((request) => seen.push(request))
  requestPaletteOpen({ scope: 'all' })
  stop()
  assert.equal(seen[0].target, undefined, 'no target means the palette works the agent out for itself')
})

if (failures > 0) {
  console.error(`paletteOpenRequest: ${failures} assertion group(s) failed`)
  process.exitCode = 1
} else {
  console.log('paletteOpenRequest: all assertions passed')
}
