import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { APP_THEMES, colorSchemeForResolvedTheme } from '../types/appTheme'

// The categorical chart series (`--chart-1` … `--chart-8`, `--chart-other`) are a
// mark colour, so each has to clear WCAG's 3:1 non-text floor against the surface
// a chart is drawn on. Read off the BUILT tokens.css — what the app actually
// loads — in both of its modes, and then against every theme's own surface in
// the mode that theme stamps, since index.css declares the series once and lets
// `data-mode` pick the step.

const CHART_TOKENS = ['1', '2', '3', '4', '5', '6', '7', '8', 'other'].map((slot) => `--sem-color-chart-${slot}`)
const MIN_CONTRAST = 3

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `tokens.css has no ${selector} block`)
  const body = css.slice(start, css.indexOf('}', start))
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]))
}

function resolve(name: string, mode: Map<string, string>, base: Map<string, string>): string {
  const value = mode.get(name) ?? base.get(name)
  assert.ok(value, `${name} is not declared`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  return alias ? resolve(alias[1]!, mode, base) : value
}

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is not a six-digit hex colour`)
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const css = readFileSync(join(process.cwd(), 'design-system', 'foundations', 'tokens.css'), 'utf8')
const light = block(css, ':root')
const dark = block(css, '[data-mode="dark"]')
const modes = { light: new Map<string, string>(), dark }

test('every chart series clears 3:1 against bg.surface in both modes', () => {
  for (const [mode, overrides] of Object.entries(modes)) {
    const surface = resolve('--sem-color-bg-surface', overrides, light)
    for (const token of CHART_TOKENS) {
      const value = resolve(token, overrides, light)
      const ratio = contrast(value, surface)
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${token} ${value} is ${ratio.toFixed(2)}:1 against the ${mode} surface ${surface}`,
      )
    }
  }
})

test('every chart series clears 3:1 against each theme surface in that theme mode', () => {
  for (const theme of APP_THEMES) {
    if (!theme.resolved || !theme.swatches) continue
    const mode = colorSchemeForResolvedTheme(theme.resolved)
    for (const token of CHART_TOKENS) {
      const value = resolve(token, modes[mode], light)
      const ratio = contrast(value, theme.swatches.bgSurface)
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${token} ${value} is ${ratio.toFixed(2)}:1 against the ${theme.id} surface ${theme.swatches.bgSurface}`,
      )
    }
  }
})

test('the eight series are eight distinct colours in each mode, none of them a status tone', () => {
  for (const [mode, overrides] of Object.entries(modes)) {
    const series = CHART_TOKENS.slice(0, 8).map((token) => resolve(token, overrides, light).toLowerCase())
    assert.equal(new Set(series).size, 8, `${mode}: the series repeat a colour`)
    for (const status of ['good', 'warn', 'danger']) {
      const tone = resolve(`--sem-color-status-${status}`, overrides, light).toLowerCase()
      assert.ok(!series.includes(tone), `${mode}: a chart series reuses status.${status} (${tone})`)
    }
  }
})

test('the app publishes every chart series under its un-prefixed name', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'index.css'), 'utf8')
  for (const slot of ['1', '2', '3', '4', '5', '6', '7', '8', 'other']) {
    assert.ok(
      app.includes(`--chart-${slot}: var(--sem-color-chart-${slot});`),
      `index.css does not alias --chart-${slot} to the design-system token`,
    )
  }
})
