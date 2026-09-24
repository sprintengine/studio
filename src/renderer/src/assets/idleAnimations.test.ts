import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

// Every infinite animation in the app stylesheet has to hold still while the
// window is hidden or in the background: with nobody looking, each frame it
// asks for is a wakeup spent on nothing. The pause is one rule keyed on
// `data-window-active`; this finds every rule that starts an infinite animation
// and checks the pause rule names it, so a new one cannot be added unpaused.

const css = readFileSync(join(__dirname, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function pauseSelector(): string {
  const match = /([^{}]*data-window-active='false'[^{}]*)\{\s*animation-play-state:\s*paused;?\s*\}/.exec(css)
  assert.ok(match, 'the stylesheet has the idle pause rule')
  return match[1]!.replace(/\s+/g, ' ')
}

test('every infinite animation in the stylesheet is paused while the window is idle', () => {
  const pause = pauseSelector()
  const infinite: string[] = []
  // Innermost rule blocks only: a selector, then declarations with no braces.
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, rawSelector, body] = match
    if (!/animation\s*:[^;]*\binfinite\b/.test(body!)) continue
    for (const selector of rawSelector!.split(',')) infinite.push(selector.trim())
  }
  assert.ok(infinite.length >= 6, `found the infinite animations (${infinite.join(', ')})`)
  for (const selector of infinite) {
    // The pause rule names each by its class (a `::after` sweep by its
    // pseudo-element); a descendant qualifier on the animating rule does not
    // change which element moves.
    const target = selector
      .split(/\s+/)
      .pop()!
      .replace(/:nth-child\([^)]*\)/, '')
    assert.ok(pause.includes(target), `${selector} animates forever, so the idle pause rule has to name ${target}`)
  }
})

test('Tailwind’s infinite utilities the app uses are paused too', () => {
  for (const utility of ['.animate-pulse', '.animate-ping']) assert.ok(pauseSelector().includes(utility), utility)
})
