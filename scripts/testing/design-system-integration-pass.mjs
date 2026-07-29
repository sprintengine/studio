#!/usr/bin/env node
// Live integration pass for the design-system conformance epic (T24).
//
// T15 proved the guard, the suite and the keyboard evidence at zero tolerance
// across T2–T12. T18–T22 landed after it, so that proof no longer covers the
// tree. This harness re-measures the two things the fix batch could only break
// together, in the built Electron app rather than in the diff:
//
//   Part A — the T18/T19 seam. T18 built the resting selection tier
//     (`--bg-selected-resting`, opted into with `data-selection-pane`); T19
//     changed what an identity-tinted Backlog row paints when selected. Both
//     land on the same pixel. On an epic-member row the three states — resting,
//     resting-selected, selected — must be three distinguishable fills, in dark
//     and light, or the two fixes disagree.
//
//   Part B — the F5 convergence. T22 put every control on one ring. A tab walk
//     of the Backlog and Extensions doors, reading *computed* style off
//     `document.activeElement`, showing which stops draw that ring and which do
//     not.
//
// The ring test here is deliberately stricter than the T15 pass's. T15 asked
// "is focus indicated at all?" (`focusIndicated`: a ring OR any focus-driven
// style delta), which a UA outline and a 1px hue shift both satisfy. T24's
// criterion is "draws the *converged* ring", so a stop only passes with a
// non-transparent, non-zero box-shadow layer in the theme's own
// `--border-focus`. A stop on `outline-style: auto` is Chromium's UA default —
// the one treatment the design system cannot theme — and is reported separately.
//
// T26 keeps that colour test and widens only WHERE the layer may be painted. A
// composite control — the door search field, whose tab stop is the <input> but
// whose visible border box is the wrapper holding the border, the glyph and the
// clear button — draws its ring on the wrapper, on `:focus-within`. The
// element-only read reported such a stop as ringless while a 2px `--border-focus`
// ring was plainly on screen around it. `ringOn` now records `self` or
// `composite`, the composite's box is named in the transcript, and a stop with
// no converged layer anywhere still fails.
//
// Trap carried forward from the T13/T15/T18/T19 passes, still true: this shell
// inherits ELECTRON_RENDERER_URL / NODE_ENV_ELECTRON_VITE from a running dev
// server. Left in the environment they make the built main process load the dev
// renderer from the main checkout instead of this branch's build. Both are
// stripped below, and `data-mode` is asserted non-null before any number is read.
//
// Trap of this pass's own: a Backlog row carries `transition-colors`. A computed
// style read in the same turn as the selection change returns the colour it is
// transitioning *from*, which reports two tiers as identical. Every read below
// is a turn behind its trigger.
//
// Prereqs: `npm run build` (needs out/main), playwright available:
//   tmp=/tmp/multicode-playwright
//   npm --prefix "$tmp" install playwright --no-audit --no-fund
//   NODE_PATH="$tmp/node_modules:$PWD/node_modules" \
//     node scripts/testing/design-system-integration-pass.mjs
//
// Screenshots + a JSON transcript land in $MULTICODE_T24_OUT_DIR.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(new URL('../..', import.meta.url).pathname)
const tempRoot = process.env.MULTICODE_T24_TMP_ROOT || '/tmp/multicode-t24-integration'
const workspaceDir = join(tempRoot, 'workspace')
const userDataDir = join(tempRoot, 'user-data')
const outDir = process.env.MULTICODE_T24_OUT_DIR || join(tempRoot, 'out')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const transcript = { partA: [], partB: [] }

/* ------------------------------------------------------------------ *
 * Colour, in the renderer
 * ------------------------------------------------------------------ */

// The tint is a `color-mix(in oklab, …)` and getComputedStyle hands that back as
// a raw `oklab(L a b)` string. Read naively it is not on the same scale as a
// token's `rgb()` and every contrast number computed from it is fiction — the
// trap the T13 review recorded. Every colour below goes through a 1x1 canvas
// first, so a tinted row and a token are compared as sRGB.
const MEASURE_LIB = `
  const swatchCanvas = document.createElement('canvas')
  swatchCanvas.width = swatchCanvas.height = 1
  const swatchCtx = swatchCanvas.getContext('2d', { willReadFrequently: true })
  const toSrgb = (value) => {
    if (!value || /^rgba?\\(/.test(value)) return value
    swatchCtx.fillStyle = '#000000'
    swatchCtx.fillStyle = value
    swatchCtx.fillRect(0, 0, 1, 1)
    const d = swatchCtx.getImageData(0, 0, 1, 1).data
    return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
  }
  const effectiveFill = (el) => {
    let node = el
    while (node) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(bg)) return toSrgb(bg)
      node = node.parentElement
    }
    return 'rgb(0, 0, 0)'
  }
  const rowOf = (needle) =>
    Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent || '').includes(needle),
    ) || null
`

function parseRgb(value) {
  return (String(value).match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number)
}
function ratio(a, b) {
  const chan = (c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])
  const la = lum(parseRgb(a))
  const lb = lum(parseRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/* ------------------------------------------------------------------ *
 * Part A — the three selection tiers on one epic-member row
 * ------------------------------------------------------------------ */

// The row, plus the pane wiring that decides whether it can ever rest.
// `data-selection-pane` is what opts a list into the tier (assets/index.css,
// "Selection tiers"); an unmarked list is a single-pane surface and never rests,
// so recording the ancestor is what makes a missing tier legible rather than
// just a number that did not move.
const readRowScript = (needle) => `(() => {
  ${MEASURE_LIB}
  const li = rowOf(${JSON.stringify(needle)})
  if (!li) return { error: 'row not found: ' + ${JSON.stringify(needle)} }
  const pane = li.closest('[data-selection-pane]')
  const title = li.querySelector('span.truncate, [class*="font-medium"]')
  return {
    text: (li.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
    selected: li.getAttribute('aria-selected') === 'true',
    fill: effectiveFill(li),
    ownFill: toSrgb(getComputedStyle(li).backgroundColor),
    titleInk: title ? toSrgb(getComputedStyle(title).color) : null,
    pane: pane ? pane.getAttribute('data-selection-pane') : null,
    paneHasFocus: pane ? pane.matches(':focus-within') : null,
    anyPaneFocused: Boolean(document.querySelector('[data-selection-pane]:focus-within')),
    panesOnSurface: document.querySelectorAll('[data-selection-pane]').length,
  }
})()`

const tokensScript = `(() => {
  ${MEASURE_LIB}
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.opacity = '0'
  document.body.appendChild(probe)
  const token = (name) => {
    probe.style.backgroundColor = ''
    probe.style.backgroundColor = 'var(' + name + ')'
    return toSrgb(getComputedStyle(probe).backgroundColor)
  }
  const out = {
    theme: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.getAttribute('data-mode'),
    selected: token('--bg-selected'),
    resting: token('--bg-selected-resting'),
    surface: token('--bg-surface'),
    app: token('--bg-app'),
  }
  probe.remove()
  return out
})()`

// Put focus in the row's own pane, which is what the "selected" read is meant
// to measure. `element.click()` in the renderer is a SYNTHETIC click: unlike a
// real pointer press it never runs the browser's focus-the-nearest-focusable-
// ancestor step, so on its own it leaves focus wherever the previous state put
// it. That made the first theme read full strength by luck (nothing focused, so
// a `primary` pane holds the tier) and the second read the RESTING fill, because
// focus was still in the sidebar pane the resting-selected step had focused —
// selected and resting-selected then came back byte-identical on a surface where
// the tier is working. Focus the pane explicitly, the way a mouse click does.
const focusRowPaneScript = `(() => {
  const li = document.querySelector('li[role="option"][aria-selected="true"]')
  const pane = li ? li.closest('[data-selection-pane]') : null
  if (!pane) return { focused: false, reason: li ? 'the selected row is in no pane' : 'no selected row' }
  const self = pane.matches('[tabindex]:not([tabindex="-1"]), button, a[href], input') ? pane : null
  const target = self || pane.querySelector('[tabindex]:not([tabindex="-1"]), button, a[href], input')
  if (!target) return { focused: false, reason: 'no focusable in the row pane' }
  target.focus()
  return { focused: pane.matches(':focus-within'), into: target.tagName, onPaneItself: Boolean(self) }
})()`

// Focus a control on the same surface that is inside NO pane — the door's
// toolbar and its detail side. `primary` is defined to hold the full-strength
// tier here (assets/index.css, "Selection tiers"): a door that has just opened,
// or one whose user is typing in the search field, shows one focused selection
// rather than none. Scoped to the row's own surface section first so the control
// is genuinely this door's chrome and not some other region of the shell.
const focusOutsideEveryPaneScript = `(() => {
  const li = document.querySelector('li[role="option"][aria-selected="true"]')
  const surface = li ? li.closest('section[aria-label], aside[aria-label], [role="tabpanel"]') : null
  const pick = (scope) =>
    Array.from(scope.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')).find((n) => {
      if (n.closest('[data-selection-pane]')) return false
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && !n.disabled
    })
  const target = (surface && pick(surface)) || pick(document.body)
  if (!target) return { moved: false, reason: 'no focusable outside every pane' }
  target.focus()
  return {
    moved: document.activeElement === target,
    into: (target.getAttribute('aria-label') || target.textContent || '').trim().slice(0, 40),
    onThisSurface: Boolean(surface && surface.contains(target)),
    anyPaneFocused: Boolean(document.querySelector('[data-selection-pane]:focus-within')),
  }
})()`

// Selection is left where it is; only focus moves. That is the whole point of
// the tier: the remembered choice stays remembered, and only the answer to
// "which list is my keyboard driving?" changes.
const focusElsewhereScript = `(() => {
  const li = document.querySelector('li[role="option"][aria-selected="true"]')
  const pane = li ? li.closest('[data-selection-pane]') : null
  // Prefer a real second pane on this surface: that is the case the CSS is
  // written for. Fall back to any focusable control outside the row's pane.
  const otherPane = Array.from(document.querySelectorAll('[data-selection-pane]')).find((p) => p !== pane)
  const scope = otherPane || document.body
  const target = Array.from(
    scope.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])'),
  ).find((n) => {
    if (pane && pane.contains(n)) return false
    const r = n.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && !n.disabled
  })
  if (!target) return { moved: false, reason: 'no focusable control outside the row pane' }
  target.focus()
  return {
    moved: document.activeElement === target,
    into: (target.getAttribute('aria-label') || target.textContent || '').trim().slice(0, 40),
    intoOtherPane: Boolean(otherPane && otherPane.contains(target)),
  }
})()`

/* ------------------------------------------------------------------ *
 * Part B — the converged ring at every tab stop
 * ------------------------------------------------------------------ */

// Tailwind's ring utilities compile to a two-layer box-shadow whose unfocused
// layer is present but transparent and zero-sized, so `boxShadow !== 'none'`
// reports a ring on every ring-classed element whether focused or not (the trap
// the T15 pass recorded). A layer only counts when it is both non-transparent
// and non-zero-sized. Layer colours are collected so the ring can be compared
// against the theme's own `--border-focus` rather than merely counted.
const DESCRIBE_STOP = `(() => {
  function splitLayers(boxShadow) {
    const layers = []
    let depth = 0, cur = ''
    for (const ch of boxShadow) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) { layers.push(cur); cur = '' } else cur += ch
    }
    if (cur.trim()) layers.push(cur)
    return layers
  }
  function paintedLayers(boxShadow) {
    if (!boxShadow || boxShadow === 'none') return []
    return splitLayers(boxShadow).filter((layer) => {
      const colour = layer.match(/rgba?\\(([^)]+)\\)/)
      let alpha = 1
      if (colour) {
        const parts = colour[1].split(/[,\\s/]+/).filter(Boolean)
        if (parts.length >= 4) alpha = parseFloat(parts[3])
      }
      if (!(alpha > 0)) return false
      const lengths = (layer.replace(/rgba?\\([^)]*\\)/, '').match(/-?\\d*\\.?\\d+px/g) || []).map(parseFloat)
      return lengths.some((n) => n !== 0)
    })
  }

  const el = document.activeElement
  if (!el || el === document.body) return { none: true }
  const style = getComputedStyle(el)
  const layers = paintedLayers(style.boxShadow)

  // The theme's own focus colour, read as the custom property in effect *on
  // this element* — custom properties inherit, so this honours a theme override
  // in any ancestor. Read off the element rather than a probe appended to it:
  // an <input> is a replaced element, its children never take part in the
  // cascade, and a probe inside one resolves every var() to the initial value.
  const swatch = document.createElement('canvas')
  swatch.width = swatch.height = 1
  const sctx = swatch.getContext('2d', { willReadFrequently: true })
  const toRgb = (value) => {
    if (!value) return null
    sctx.fillStyle = '#000000'
    sctx.fillStyle = value.trim()
    sctx.fillRect(0, 0, 1, 1)
    const d = sctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const borderFocusRaw = style.getPropertyValue('--border-focus')
  const borderFocusRgb = toRgb(borderFocusRaw)

  // Compare by channel, not by string. The ring compiles through Tailwind's
  // --tw-ring-* pipeline, which can hand back \`rgba(r, g, b, a)\` where the token
  // is \`rgb(r, g, b)\`; string equality then reports a painted ring as absent.
  // Alpha is carried through separately so a translucent ring is visible as
  // such rather than silently counted as converged.
  const layerColour = (l) => {
    const m = l.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
    return { rgb: parts.slice(0, 3), alpha: parts.length >= 4 ? parts[3] : 1 }
  }
  const ringLayer = layers.find((l) => {
    const c = layerColour(l)
    return (
      c && borderFocusRgb && c.rgb.every((n, i) => Math.abs(n - borderFocusRgb[i]) <= 1)
    )
  })
  const ringAlpha = ringLayer ? layerColour(ringLayer).alpha : null

  // A composite control paints its ring on the box a user sees, not on the box
  // that takes focus: a search field's tab stop is the <input>, but its visible
  // border box is the wrapper that owns the border, the glyph and the clear
  // button, and the wrapper draws the ring on \`:focus-within\`. An element-only
  // read reports such a stop as ringless when it is in fact ringed. Walk up
  // while each ancestor is itself :focus-within — that chain terminates at the
  // composite, so this cannot borrow a ring from an unrelated ancestor — and
  // look for the same converged layer. Kept as its own field, never folded into
  // \`convergedRing\`, so the transcript always says WHERE the ring was drawn.
  const matchesBorderFocus = (l) => {
    const c = layerColour(l)
    return Boolean(c && borderFocusRgb && c.rgb.every((n, i) => Math.abs(n - borderFocusRgb[i]) <= 1))
  }
  let compositeRing = null
  if (!ringLayer) {
    let node = el.parentElement
    while (node && node !== document.body) {
      let within = false
      try { within = node.matches(':focus-within') } catch (e) { within = false }
      if (!within) break
      const found = paintedLayers(getComputedStyle(node).boxShadow).find(matchesBorderFocus)
      if (found) {
        compositeRing = {
          layer: found.trim(),
          on: node.tagName + (node.getAttribute('class') ? '.' + node.getAttribute('class').split(/\\s+/)[0] : ''),
        }
        break
      }
      node = node.parentElement
    }
  }

  const outlineWidth = parseFloat(style.outlineWidth || '0')
  const rect = el.getBoundingClientRect()
  let focusVisible = false
  try { focusVisible = el.matches(':focus-visible') } catch (e) { focusVisible = false }

  return {
    tag: el.tagName,
    role: el.getAttribute('role') || '',
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46),
    // The converged ring: a painted box-shadow layer in the theme's own
    // --border-focus. Colour, not merely presence — an elevation shadow is a
    // painted layer too.
    convergedRing: Boolean(ringLayer),
    ringLayer: ringLayer ? ringLayer.trim() : null,
    ringAlpha,
    // The ring the stop actually shows, and which box draws it.
    compositeRing,
    ringOn: ringLayer ? 'self' : compositeRing ? 'composite' : null,
    focusVisible,
    anyPaintedShadow: layers.length > 0,
    paintedLayers: layers.map((l) => l.trim()),
    borderFocus: borderFocusRaw.trim(),
    borderFocusRgb,
    // Chromium's UA default. Not a token: drawn by the platform, changes with
    // the OS and the Chromium version, unthemeable.
    uaOutline: style.outlineStyle === 'auto' && outlineWidth > 0,
    outline: style.outlineStyle + ' ' + style.outlineWidth + ' ' + style.outlineColor,
    boxShadow: style.boxShadow || 'none',
    offscreen: rect.width === 0 || rect.height === 0,
    container: (() => {
      const c = el.closest('[role="tabpanel"], section[aria-label], aside[aria-label], [role="dialog"]')
      return c ? (c.getAttribute('aria-label') || c.id || c.tagName) : ''
    })(),
  }
})()`

// Walk until focus cycles back to a stop already seen, or the cap is hit. A
// fixed step count either stops short of the end of a door or wraps into the
// shell and measures it twice.
async function tabWalk(page, surface, cap = 70) {
  const stops = []
  const seen = new Set()
  console.log(`\n--- ${surface}: tab walk (cap ${cap}) ---`)
  for (let i = 0; i < cap; i += 1) {
    await page.keyboard.press('Tab')
    // The ring fades in under `transition-colors`. Read too early and the layer
    // is caught mid-transition at alpha ~0.87-0.94, which reads as a second,
    // translucent focus treatment that does not exist. Settle first.
    await page.waitForTimeout(320)
    const s = await page.evaluate(DESCRIBE_STOP)
    if (s.none) {
      console.log(`  ${String(i + 1).padStart(2)}  (nothing focused)`)
      continue
    }
    const key = `${s.tag}/${s.role}/${s.label}/${s.container}`
    if (seen.has(key)) {
      console.log(`  ${String(i + 1).padStart(2)}  (cycled back to "${s.label}") — walk complete`)
      break
    }
    seen.add(key)
    s.index = stops.length + 1
    stops.push(s)
    console.log(
      `  ${String(s.index).padStart(2)}  ${s.tag}${s.role ? '/' + s.role : ''} "${s.label}" in[${s.container}]` +
        `  ring=${Boolean(s.ringOn)}${s.ringOn === 'composite' ? ` (on ${s.compositeRing.on})` : ''}` +
        `${s.ringAlpha !== null && s.ringAlpha < 1 ? `(alpha ${s.ringAlpha})` : ''}` +
        `${s.uaOutline ? ' UA-OUTLINE' : ''} focusVisible=${s.focusVisible}` +
        (!s.ringOn
          ? `\n        --border-focus=${s.borderFocus} painted=[${s.paintedLayers.join(' | ') || 'none'}] outline=${s.outline}`
          : ''),
    )
  }
  transcript.partB.push({ surface, stops })
  return stops
}

function assertConvergedRing(surface, stops) {
  const landed = stops.filter((s) => !s.offscreen)
  const missing = landed.filter((s) => !s.ringOn)
  const composite = landed.filter((s) => s.ringOn === 'composite')
  const ua = landed.filter((s) => s.uaOutline)
  check(
    `${surface}: every tab stop draws the converged ring`,
    landed.length > 0 && missing.length === 0,
    `${landed.length} stop(s); ${missing.length} without the ring` +
      (missing.length ? ` → ${missing.map((s) => `${s.tag}/${s.role || '-'} "${s.label}"`).join(' | ')}` : '') +
      (composite.length
        ? `; ${composite.length} drawn by the composite's own box → ${composite
            .map((s) => `"${s.label}" on ${s.compositeRing.on}`)
            .join(' | ')}`
        : '') +
      (ua.length ? `; ${ua.length} on the Chromium UA outline` : ''),
  )
  return { landed, missing, composite, ua }
}

/* ------------------------------------------------------------------ *
 * App driving
 * ------------------------------------------------------------------ */

async function click(page, locator) {
  if ((await locator.count()) === 0) return false
  await locator.first().evaluate((el) => el.click())
  await page.waitForTimeout(700)
  return true
}

async function headings(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter((h) => {
        const r = h.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .map((h) => (h.textContent || '').trim())
      .join(' | '),
  )
}

// The onboarding wizard stays mounted underneath an opened door, so its controls
// stay in the tab order and would pollute every walk. It has to actually finish.
async function finishOnboarding(page) {
  await click(page, page.locator('button').filter({ hasText: /^Get started$/ }))
  for (let i = 0; i < 20; i += 1) {
    const heads = await headings(page)
    if (!/Pick a theme|Set up an agent CLI|Add extensions|Bring over|Welcome/i.test(heads)) return true
    const advanced =
      (await click(page, page.locator('button').filter({ hasText: /^Continue$/ }).last())) ||
      (await click(page, page.locator('button').filter({ hasText: /^Skip for now$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Done|Finish|Start)$/ })))
    if (!advanced) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  }
  return false
}

// The clear affordance only exists while the field has a value, so a walk over
// an empty field never measures it. React owns the input, so the value has to go
// in through the native setter for the component to see it.
async function fillSearchField(page, labelFragment, text) {
  const filled = await page.evaluate(
    ({ fragment, value }) => {
      const input = Array.from(document.querySelectorAll('input[type="search"]')).find((n) =>
        (n.getAttribute('aria-label') || '').includes(fragment),
      )
      if (!input) return { ok: false, reason: 'no search field matching ' + fragment }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    },
    { fragment: labelFragment, value: text },
  )
  await page.waitForTimeout(600)
  const hasClear = await page.evaluate(() =>
    Boolean(document.querySelector('button[aria-label="Clear search"]')),
  )
  return { ...filled, hasClear }
}

async function enterSurface(page, selector) {
  const ok = await page.evaluate((sel) => {
    const node = document.querySelector(sel)
    if (!node) return false
    if (!node.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) {
      node.setAttribute('tabindex', '-1')
    }
    node.focus()
    return document.activeElement === node || node.contains(document.activeElement)
  }, selector)
  await page.waitForTimeout(300)
  return ok
}

/* ------------------------------------------------------------------ *
 * Seed: one coloured epic with members, plus a plain row to compare against
 * ------------------------------------------------------------------ */

const EPIC_SLUG = 'tinted-epic'
const MEMBER = 'Member row inside the tinted epic'
const MEMBER_2 = 'Second member of the tinted epic'
const PLAIN = 'Plain row with no colour at all'

async function seed() {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(join(workspaceDir, 'backlog/epics'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(workspaceDir, `backlog/epics/${EPIC_SLUG}.md`),
    `---\ntype: epic\nstatus: in_progress\ncolor: purple\n---\n\n# Tinted epic\n\nAn epic with an identity colour, so its members carry the full-row tint.\n`,
  )
  for (const [slug, title, extra] of [
    [`${EPIC_SLUG}-one`, MEMBER, `epic: ${EPIC_SLUG}\n`],
    [`${EPIC_SLUG}-two`, MEMBER_2, `epic: ${EPIC_SLUG}\n`],
    ['plain-one', PLAIN, ''],
  ]) {
    await writeFile(
      join(workspaceDir, `backlog/2026-07-29-${slug}.md`),
      `---\nstatus: ready\n${extra}---\n\n# ${title}\n\nSeeded row for the T24 integration pass.\n`,
    )
  }
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

async function measureTiers(page, theme) {
  const tokens = await page.evaluate(tokensScript)
  console.log(`\n  tokens: --bg-selected ${tokens.selected} · --bg-selected-resting ${tokens.resting}`)
  check(
    `${theme}: --bg-selected-resting resolves and is not --bg-selected`,
    Boolean(tokens.resting) && tokens.resting !== tokens.selected,
    `selected=${tokens.selected} resting=${tokens.resting}`,
  )

  // 1. resting — the row unselected, carrying its epic tint. Selection is a
  // single-choice list, so the previous theme's pass leaves the epic row still
  // selected; picking the plain row is how a user hands the selection back.
  // Without this the second theme reads the *selected* fill and calls it resting,
  // and all three tiers collapse onto one number.
  await page.evaluate(
    (needle) => {
      const li = Array.from(document.querySelectorAll('li[role="option"]')).find((n) =>
        (n.textContent || '').includes(needle),
      )
      if (li) li.click()
    },
    PLAIN,
  )
  await page.waitForTimeout(700)
  const restingRow = await page.evaluate(readRowScript(MEMBER))
  check(
    `${theme}: the epic-member row is unselected before the resting read`,
    restingRow.error ? false : restingRow.selected === false,
    JSON.stringify({ selected: restingRow.selected, fill: restingRow.fill }),
  )
  if (restingRow.error) {
    check(`${theme}: the epic-member row is on screen`, false, restingRow.error)
    return null
  }

  // 2. selected — clicked, with focus in the list (see focusRowPaneScript: the
  // synthetic click does not put it there by itself).
  await page.evaluate(
    (needle) => {
      const li = Array.from(document.querySelectorAll('li[role="option"]')).find((n) =>
        (n.textContent || '').includes(needle),
      )
      if (li) li.click()
    },
    MEMBER,
  )
  const listFocused = await page.evaluate(focusRowPaneScript)
  await page.waitForTimeout(700)
  const selectedRow = await page.evaluate(readRowScript(MEMBER))
  check(
    `${theme}: focus is inside the row's own pane for the selected read`,
    listFocused.focused === true,
    JSON.stringify(listFocused),
  )

  // 2b. selected, focus outside every pane — the door's toolbar / detail side.
  // A `primary` pane holds the full-strength tier here; an `auto` one would
  // already be resting, which is the difference the ruling turns on.
  const outside = await page.evaluate(focusOutsideEveryPaneScript)
  await page.waitForTimeout(700)
  const selectedNoPaneRow = await page.evaluate(readRowScript(MEMBER))

  // 3. resting-selected — selection unchanged, focus moved off the row's pane.
  const moved = await page.evaluate(focusElsewhereScript)
  await page.waitForTimeout(700)
  const restingSelectedRow = await page.evaluate(readRowScript(MEMBER))

  // Fail loudly before comparing. A row that scrolled out of the list, or a
  // click that did not take, returns `{ error }` with no `fill`; the contrast
  // helper reads that as black and hands back a clean 1.000:1, which is exactly
  // the shape of the finding this pass reports. An unguarded read here would
  // manufacture "the tier never applies" out of a broken selector.
  const reads = {
    selected: selectedRow,
    selectedFocusOutsideEveryPane: selectedNoPaneRow,
    restingSelected: restingSelectedRow,
  }
  for (const [name, row] of Object.entries(reads)) {
    if (row.error || typeof row.fill !== 'string') {
      check(`${theme}: the ${name} state could be read off the row`, false, JSON.stringify(row))
      return null
    }
  }
  // The tier is about focus, not about selection: if the row stopped being the
  // selected one when focus left, the two states are not comparable at all.
  check(
    `${theme}: the row stays selected while focus moves off its pane`,
    selectedRow.selected === true && restingSelectedRow.selected === true,
    `selected-state=${selectedRow.selected} resting-selected-state=${restingSelectedRow.selected}` +
      ` focusMoved=${moved.moved} intoOtherPane=${moved.intoOtherPane}`,
  )
  check(
    `${theme}: focus actually left the row's pane`,
    moved.moved === true,
    JSON.stringify(moved),
  )

  const result = {
    theme,
    tokens,
    pane: restingRow.pane,
    panesOnSurface: restingRow.panesOnSurface,
    listFocused,
    focusOutsideEveryPane: outside,
    focusMovedTo: moved,
    resting: restingRow.fill,
    selected: selectedRow.fill,
    selectedFocusOutsideEveryPane: selectedNoPaneRow.fill,
    restingSelected: restingSelectedRow.fill,
    titleInk: {
      resting: restingRow.titleInk,
      selected: selectedRow.titleInk,
      selectedFocusOutsideEveryPane: selectedNoPaneRow.titleInk,
      restingSelected: restingSelectedRow.titleInk,
    },
    steps: {
      restingToSelected: ratio(restingRow.fill, selectedRow.fill),
      restingToRestingSelected: ratio(restingRow.fill, restingSelectedRow.fill),
      restingSelectedToSelected: ratio(restingSelectedRow.fill, selectedRow.fill),
    },
  }
  transcript.partA.push(result)

  console.log(
    `  resting          ${result.resting}\n` +
      `  resting-selected ${result.restingSelected}   (step from resting ${result.steps.restingToRestingSelected.toFixed(3)}:1)\n` +
      `  selected         ${result.selected}   (step from resting-selected ${result.steps.restingSelectedToSelected.toFixed(3)}:1, from resting ${result.steps.restingToSelected.toFixed(3)}:1)\n` +
      `  selected, focus outside every pane  ${result.selectedFocusOutsideEveryPane}   (into ${JSON.stringify(outside)})\n` +
      `  title ink: resting ${result.titleInk.resting} · selected ${result.titleInk.selected} · resting-selected ${result.titleInk.restingSelected}\n` +
      `  row pane: ${result.pane === null ? 'NONE — the list is not a data-selection-pane' : result.pane}` +
      ` · panes on surface: ${result.panesOnSurface} · focus moved into: ${JSON.stringify(moved)}`,
  )

  const distinct = new Set([result.resting, result.restingSelected, result.selected]).size
  check(
    `${theme}: resting / resting-selected / selected are three distinct fills on an epic-member row`,
    distinct === 3,
    `${distinct} distinct fill(s): resting=${result.resting} resting-selected=${result.restingSelected} selected=${result.selected}` +
      (result.pane === null ? ' — the Backlog list carries no data-selection-pane, so it never rests' : ''),
  )
  // `primary`, not `auto`: the tier survives focus leaving the list for the
  // door's own chrome, and only another pane takes it away.
  check(
    `${theme}: the row keeps the full-strength fill while focus sits outside every pane`,
    outside.moved === true && result.selectedFocusOutsideEveryPane === result.selected,
    `focus in ${JSON.stringify(outside)} → ${result.selectedFocusOutsideEveryPane} (selected ${result.selected})`,
  )
  // The ink half of the same tier (review R3). One channel is not a tier: the
  // title has to move with the fill, and rest with it.
  check(
    `${theme}: the title ink lifts on selection and rests with the fill`,
    result.titleInk.resting !== null &&
      result.titleInk.resting !== result.titleInk.selected &&
      result.titleInk.restingSelected === result.titleInk.resting,
    `resting=${result.titleInk.resting} selected=${result.titleInk.selected} resting-selected=${result.titleInk.restingSelected}`,
  )
  return result
}

async function main() {
  const { _electron: electron } = require('playwright')
  const electronPath = require('electron')
  await seed()

  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.NODE_ENV

  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: {
      ...env,
      MULTICODE_USER_DATA_DIR: userDataDir,
      MULTICODE_ALLOW_MULTI_INSTANCE: '1',
      MULTICODE_TEST_OPEN_DIR: workspaceDir,
    },
  })

  try {
    const page = await app.firstWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[renderer] ${m.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(1440, 900)
      w.center()
    })
    await page.waitForTimeout(2000)

    const built = await page.evaluate(() => ({
      mode: document.documentElement.getAttribute('data-mode'),
      theme: document.documentElement.getAttribute('data-theme'),
    }))
    check(
      'the built renderer is the one under test (data-mode is stamped)',
      built.mode !== null,
      JSON.stringify(built),
    )

    await finishOnboarding(page)

    console.log('\n=== creating the workspace ===')
    await click(page, page.locator('button').filter({ hasText: /^New Workspace$/ }))
    await page.waitForTimeout(1200)
    await page.locator('input[placeholder="my-workspace"]').first().fill('T24 Integration')
    await page.locator('input[placeholder="/path/to/workspace"]').first().fill(workspaceDir)
    await page.waitForTimeout(500)
    const created =
      (await click(page, page.locator('button').filter({ hasText: /^Skip the rest and create$/ }))) ||
      (await click(page, page.locator('button').filter({ hasText: /^(Create workspace|Create)$/ }).last()))
    await page.waitForTimeout(4000)
    check('a real workspace is created and open', created)

    /* ---------------- Part A: the three selection tiers ---------------- */
    console.log('\n\n################ PART A — selection tiers on an epic-member row ################')
    await click(page, page.getByRole('button', { name: 'Backlog', exact: true }))
    await page.waitForTimeout(2500)
    const rowCount = await page.locator('li[role="option"]').count()
    check('the Backlog door lists the seeded rows', rowCount >= 3, `${rowCount} rows`)
    await page.screenshot({ path: join(outDir, '00-backlog-door.png') })

    for (const theme of ['dark', 'light']) {
      console.log(`\n########## THEME: ${theme} ##########`)
      await page.evaluate((next) => {
        document.documentElement.setAttribute('data-theme', next)
        document.documentElement.setAttribute('data-mode', next)
      }, theme)
      await page.waitForTimeout(600)
      await measureTiers(page, theme)
      await page.screenshot({ path: join(outDir, `01-${theme}-tiers.png`) })
    }

    // Back to dark for the walks, so both doors are measured on one theme.
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
      document.documentElement.setAttribute('data-mode', 'dark')
    })
    await page.waitForTimeout(500)

    /* ---------------- Part B: the converged ring ---------------- */
    console.log('\n\n################ PART B — the converged ring, door by door ################')

    console.log('\n=== Backlog door ===')
    const backlogSearch = await fillSearchField(page, 'backlog', 'row')
    check(
      'the Backlog search field is non-empty for the walk, so `Clear search` is a stop',
      backlogSearch.ok && backlogSearch.hasClear,
      JSON.stringify(backlogSearch),
    )
    await enterSurface(page, 'section[aria-label="Backlog"], aside[aria-label="Backlog list"], main')
    const backlogStops = await tabWalk(page, 'Backlog door')
    const backlogRings = assertConvergedRing('Backlog door', backlogStops)
    await page.screenshot({ path: join(outDir, '10-backlog-walk.png') })

    console.log('\n=== Extensions door ===')
    await click(page, page.getByRole('button', { name: 'Extensions', exact: true }))
    await page.waitForTimeout(2500)
    await page.screenshot({ path: join(outDir, '20-extensions-door.png') })
    const extRowCount = await page.evaluate(
      () => document.querySelectorAll('li, [role="option"], [role="tab"]').length,
    )
    check('the Extensions door rendered', extRowCount > 0, `${extRowCount} list/tab node(s)`)
    const extSearch = await fillSearchField(page, 'connectors', 'a')
    check(
      'the Extensions search field is non-empty for the walk, so `Clear search` is a stop',
      extSearch.ok && extSearch.hasClear,
      JSON.stringify(extSearch),
    )
    await enterSurface(page, 'section[aria-label="Extensions"], aside[aria-label], main')
    const extStops = await tabWalk(page, 'Extensions door')
    const extRings = assertConvergedRing('Extensions door', extStops)
    await page.screenshot({ path: join(outDir, '21-extensions-walk.png') })

    /* ---------------- Summary ---------------- */
    console.log('\n\n################ SUMMARY ################')
    const allMissing = [...backlogRings.missing, ...extRings.missing]
    const allComposite = [...backlogRings.composite, ...extRings.composite]
    const allUa = [...backlogRings.ua, ...extRings.ua]
    console.log(
      `  tab stops measured: ${backlogRings.landed.length} (Backlog) + ${extRings.landed.length} (Extensions)` +
        ` = ${backlogRings.landed.length + extRings.landed.length}\n` +
        `  without the converged ring: ${allMissing.length}\n` +
        `  drawn by the composite's own box: ${allComposite.length}\n` +
        `  on the Chromium UA outline: ${allUa.length}`,
    )
    for (const s of allComposite) {
      console.log(`    ~ ${s.tag}/${s.role || '-'} "${s.label}"  ring on ${s.compositeRing.on}: ${s.compositeRing.layer}`)
    }
    for (const s of allMissing) {
      console.log(`    - ${s.tag}/${s.role || '-'} "${s.label}"  boxShadow=${s.boxShadow}  outline=${s.outline}`)
    }

    await writeFile(
      join(outDir, 'transcript.json'),
      JSON.stringify({ checks, ...transcript }, null, 2),
    )
  } finally {
    await app.close().catch(() => {})
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Output in ${outDir}`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
