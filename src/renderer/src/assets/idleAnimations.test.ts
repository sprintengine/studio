import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

// Every infinite animation in the app stylesheet has to hold still while the
// window is hidden or in the background: with nobody looking, each frame it
// asks for is a wakeup spent on nothing. The pause is one rule keyed on
// `data-window-active`; this finds every rule that starts an infinite animation
// and checks the pause rule names it, so a new one cannot be added unpaused.
// The same rule holds them still in the parts of a visible window nobody can
// see (an offscreen live row, a warm or cold workspace layer, an inert region),
// and nothing may override it with an inline `running`.

const css = readFileSync(join(__dirname, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// Innermost rule blocks only: a selector, then declarations with no braces.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1]!.replace(/\s+/g, ' ').trim(),
  body: match[2]!,
  index: match.index,
}))

function pauseSelector(): string {
  const rule = rules.find(
    ({ selector, body }) =>
      selector.includes("data-window-active='false'") && /^\s*animation-play-state:\s*paused;?\s*$/.test(body),
  )
  assert.ok(rule, 'the stylesheet has the idle pause rule')
  return rule.selector
}

// A selector list split on its top-level commas (not those inside `:is()`).
function splitSelectorList(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts.filter(Boolean)
}

// [ids, classes/attributes/pseudo-classes, types/pseudo-elements]. `:is()` and
// `:not()` count as their most specific argument, `:where()` as nothing.
type Specificity = [number, number, number]
function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0]
  const add = (s: Specificity) => s.forEach((n, i) => (total[i] += n))
  let rest = selector
  for (;;) {
    const fn = /:(is|not|where|has)\(/.exec(rest)
    if (!fn) break
    let depth = 1
    let end = fn.index + fn[0].length
    while (depth > 0 && end < rest.length) {
      if (rest[end] === '(') depth++
      else if (rest[end] === ')') depth--
      end++
    }
    const inner = rest.slice(fn.index + fn[0].length, end - 1)
    if (fn[1] !== 'where') {
      const args = splitSelectorList(inner).map(specificity)
      add(args.reduce((a, b) => (compare(a, b) >= 0 ? a : b), [0, 0, 0] as Specificity))
    }
    rest = rest.slice(0, fn.index) + ' ' + rest.slice(end)
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => {
    total[1]++
    return ' '
  })
  rest = rest.replace(/::[\w-]+/g, () => {
    total[2]++
    return ' '
  })
  rest = rest.replace(/:[\w-]+(\([^)]*\))?/g, () => {
    total[1]++
    return ' '
  })
  total[0] += (rest.match(/#[\w-]+/g) ?? []).length
  total[1] += (rest.match(/\.[\w-]+/g) ?? []).length
  total[2] += (rest.replace(/[#.][\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length
  return total
}
function compare(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function infiniteAnimationSelectors(): string[] {
  const infinite: string[] = []
  for (const { selector, body } of rules) {
    if (!/animation\s*:[^;]*\binfinite\b/.test(body)) continue
    infinite.push(...splitSelectorList(selector))
  }
  return infinite
}

test('every infinite animation in the stylesheet is paused while the window is idle', () => {
  const pause = pauseSelector()
  const infinite = infiniteAnimationSelectors()
  assert.ok(infinite.length >= 6, `found the infinite animations (${infinite.join(', ')})`)
  for (const selector of infinite) {
    // The pause rule names each by one of its classes (a `::after` sweep with
    // its pseudo-element); a descendant qualifier on the animating rule does
    // not change which element moves, and any one class the moving element
    // always has is enough to reach it.
    const compound = selector
      .split(/\s+/)
      .pop()!
      .replace(/:nth-child\([^)]*\)/, '')
    const pseudo = /::[\w-]+$/.exec(compound)?.[0] ?? ''
    const classes = compound.replace(pseudo, '').match(/\.[\w-]+/g) ?? []
    assert.ok(
      classes.some((name) => new RegExp(`${name.replace('.', '\\.')}${pseudo}(?![\\w-])`).test(pause)),
      `${selector} animates forever, so the idle pause rule has to name ${classes.join(' or ')}${pseudo}`,
    )
  }
})

test('the pause covers the parts of a visible window nobody can see', () => {
  const conditions = [
    ":root[data-window-active='false']",
    '[data-live-offscreen]',
    "[data-layer-state='warm']",
    "[data-layer-state='cold']",
    '[inert]',
  ]
  for (const selector of splitSelectorList(pauseSelector())) {
    for (const condition of conditions)
      assert.ok(selector.includes(condition), `${selector} also holds still under ${condition}`)
  }
})

test('the pause outranks every rule that starts an infinite animation', () => {
  // An `animation` shorthand resets the play state, so a more specific rule
  // that starts a loop would quietly restart it under the pause.
  const pause = splitSelectorList(pauseSelector())
    .map(specificity)
    .reduce((a, b) => (compare(a, b) <= 0 ? a : b))
  for (const selector of infiniteAnimationSelectors()) {
    assert.ok(
      compare(pause, specificity(selector)) > 0,
      `the pause (${pause.join(',')}) outranks ${selector} (${specificity(selector).join(',')})`,
    )
  }
})

test('Tailwind’s infinite utilities the app uses are paused too', () => {
  for (const utility of ['.animate-pulse', '.animate-ping']) assert.ok(pauseSelector().includes(utility), utility)
})

test('nothing resumes an animation with an inline play state, which would beat the pause', () => {
  const root = join(__dirname, '..')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path)
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8')
        if (
          /animationPlayState\s*[:=]\s*['"`]running/.test(source) ||
          /['"]animation-play-state['"]\s*,\s*['"]running/.test(source)
        )
          offenders.push(path.slice(root.length + 1))
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [], 'an inline `running` outranks the stylesheet pause; clear the property instead')
})
