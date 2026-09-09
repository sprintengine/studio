import assert from 'node:assert/strict'
import type { ISearchOptions } from '@xterm/addon-search'

import {
  createTerminalSearchHandle,
  terminalSearchDecorations,
  terminalSearchOptions,
} from './terminalSearch'

// No `window` is installed here on purpose: `terminalTheme.readVar` falls back
// to the dark default when there is none, so this file exercises the dark pair
// and, more usefully, the handle's contract — which options every find is run
// with, and that an empty term is never handed to the addon at all.

type Recorded = { term: string; options: ISearchOptions | undefined }

function createFakeAddon() {
  const next: Recorded[] = []
  const previous: Recorded[] = []
  let cleared = 0
  let activeCleared = 0
  const listeners = new Set<(event: { resultIndex: number; resultCount: number }) => void>()
  return {
    next,
    previous,
    get cleared() {
      return cleared
    },
    get activeCleared() {
      return activeCleared
    },
    emitResults: (event: { resultIndex: number; resultCount: number }) => {
      for (const listener of [...listeners]) listener(event)
    },
    get listenerCount() {
      return listeners.size
    },
    findNext: (term: string, options?: ISearchOptions) => {
      next.push({ term, options })
      return true
    },
    findPrevious: (term: string, options?: ISearchOptions) => {
      previous.push({ term, options })
      return true
    },
    clearDecorations: () => {
      cleared += 1
    },
    clearActiveDecoration: () => {
      activeCleared += 1
    },
    onDidChangeResults: (listener: (event: { resultIndex: number; resultCount: number }) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
}

function run(name: string, body: () => void): void {
  body()
  console.log(`ok - ${name}`)
}

run('a find is literal and case-insensitive', () => {
  const options = terminalSearchOptions()
  // A terminal buffer is full of `[`, `(`, `.` and `*`. Regex-by-default would
  // turn the commonest thing a person searches for — a path, a flag, an error
  // string — into a syntax error or a wrong match, with nothing said.
  assert.equal(options.regex, false)
  assert.equal(options.wholeWord, false)
  assert.equal(options.caseSensitive, false)
})

run('decorations are literal #RRGGBB, which is all xterm accepts', () => {
  const decorations = terminalSearchDecorations()
  assert.ok(decorations)
  for (const [key, value] of Object.entries(decorations)) {
    assert.match(value as string, /^#[0-9a-f]{6}$/u, `${key} must be #RRGGBB, got ${String(value)}`)
  }
  // The active match must be distinguishable from the rest, or "3 of 12" names
  // a match the eye cannot find.
  assert.notEqual(decorations.matchBackground, decorations.activeMatchBackground)
})

run('an empty term never reaches the addon', () => {
  const addon = createFakeAddon()
  const handle = createTerminalSearchHandle(addon as never)

  assert.equal(handle.findNext(''), false)
  assert.equal(handle.findPrevious(''), false)

  assert.deepEqual(addon.next, [])
  assert.deepEqual(addon.previous, [])
})

run('both directions run with the same options', () => {
  const addon = createFakeAddon()
  const handle = createTerminalSearchHandle(addon as never)

  handle.findNext('error')
  handle.findPrevious('error')

  assert.deepEqual(addon.next.map((entry) => entry.term), ['error'])
  assert.deepEqual(addon.previous.map((entry) => entry.term), ['error'])
  assert.deepEqual(addon.next[0].options, addon.previous[0].options)
  assert.equal(addon.next[0].options?.regex, false)
})

run('options are rebuilt per call, so a theme change re-tints the highlights', () => {
  const addon = createFakeAddon()
  const handle = createTerminalSearchHandle(addon as never)

  handle.findNext('a')
  handle.findNext('a')

  // Two distinct objects: captured-once options would keep painting the old
  // theme's colours after the user switched appearance.
  assert.notEqual(addon.next[0].options, addon.next[1].options)
  assert.deepEqual(addon.next[0].options, addon.next[1].options)
})

run('clear and clearActive are separate acts', () => {
  const addon = createFakeAddon()
  const handle = createTerminalSearchHandle(addon as never)

  handle.clearActive()
  assert.equal(addon.activeCleared, 1)
  assert.equal(addon.cleared, 0, 'blurring the field must not drop every highlight')

  handle.clear()
  assert.equal(addon.cleared, 1)
})

run('results are reported as index/count and unsubscribe cleanly', () => {
  const addon = createFakeAddon()
  const handle = createTerminalSearchHandle(addon as never)
  const seen: Array<{ index: number; count: number }> = []

  const subscription = handle.onResults((results) => seen.push(results))
  addon.emitResults({ resultIndex: 2, resultCount: 12 })
  subscription.dispose()
  addon.emitResults({ resultIndex: 3, resultCount: 12 })

  assert.deepEqual(seen, [{ index: 2, count: 12 }])
  assert.equal(addon.listenerCount, 0)
})

console.log('\n7 passed')
