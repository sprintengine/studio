import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { APP_THEMES } from '../../../src/renderer/src/types/appTheme'
import { THEME_TOKENS } from '../src/index'

// Every published theme token must actually be available in every app theme:
// defined in the TOP-LEVEL base `:root` block (which cascades everywhere,
// unconditionally) or in every top-level `:root[data-theme=…]` block. A theme
// refactor that drops a published token — or moves it behind an at-rule
// condition — fails here instead of silently breaking installed modules.

type Block = { selector: string; body: string }

// Balanced-brace scan of TOP-LEVEL blocks only. A `:root` nested inside an
// at-rule (@media, @supports, a conditioned @layer) is conditional and must
// NOT count as base coverage, so at-rule blocks are consumed whole (their
// nested content never surfaces as a top-level selector).
function topLevelBlocks(css: string): Block[] {
  const blocks: Block[] = []
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    // Preceding top-level statements (`@layer a, b;`) end at ';' — the
    // selector is only the segment after the last one.
    const before = css.slice(i, open)
    const selector = before.slice(before.lastIndexOf(';') + 1).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    blocks.push({ selector, body: css.slice(open + 1, j - 1) })
    i = j
  }
  return blocks
}

function customProps(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!))
}

function main(): void {
  const cssPath = join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'index.css')
  let css = readFileSync(cssPath, 'utf8')
  // @import url(...) values carry semicolons and commas that would pollute the
  // selector of the first block; strip whole import lines, then comments.
  css = css.replace(/^@import[^\n]*$/gm, '')
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')

  const base = new Set<string>()
  const themes = new Map<string, Set<string>>()
  for (const block of topLevelBlocks(css)) {
    if (block.selector.startsWith('@')) continue
    const props = customProps(block.body)
    for (const part of block.selector
      .split(',')
      .map((piece) => piece.trim())
      .filter(Boolean)) {
      if (part === ':root') {
        props.forEach((prop) => base.add(prop))
        continue
      }
      // Both quote styles; ONLY the bare theme selector (a compound selector
      // like `:root[data-theme="x"] .time-control` scopes to descendants and
      // is not theme-wide token coverage).
      const theme = /^:root\[data-theme=("([^"]+)"|'([^']+)')\]$/.exec(part)
      const themeId = theme?.[2] ?? theme?.[3]
      if (themeId) {
        const set = themes.get(themeId) ?? new Set<string>()
        props.forEach((prop) => set.add(prop))
        themes.set(themeId, set)
      }
    }
  }

  // Enforcement only works for themes the parser actually captured: assert
  // the captured set covers every app theme id, so a selector rewrite that
  // this parser cannot read fails loudly instead of dropping the theme from
  // the gate. 'system' resolves to another theme and has no CSS block.
  const expectedThemes = APP_THEMES.map((theme) => theme.id).filter((id) => id !== 'system')
  const unparsed = expectedThemes.filter((id) => !themes.has(id))
  assert.deepEqual(
    unparsed,
    [],
    `app themes missing from the parsed index.css blocks (selector drift?): ${unparsed.join(', ')}`,
  )

  const failures: string[] = []
  for (const token of THEME_TOKENS) {
    if (base.has(token)) continue
    const missingIn = [...themes.entries()].filter(([, props]) => !props.has(token)).map(([theme]) => theme)
    if (missingIn.length > 0) {
      failures.push(`${token} — not in top-level base :root and missing from theme(s): ${missingIn.join(', ')}`)
    }
  }

  assert.deepEqual(
    failures,
    [],
    `published THEME_TOKENS entries are not guaranteed in every theme:\n  ${failures.join('\n  ')}`,
  )

  console.log(`theme tokens guard passed (${THEME_TOKENS.length} tokens across ${themes.size} themes + base)`)
}

main()
