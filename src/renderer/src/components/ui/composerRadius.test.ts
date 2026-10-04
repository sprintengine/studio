import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { test } from 'vitest'

import { COMPOSER_MATERIAL_CLASS, COMPOSER_SURFACE_CLASS } from './tokens'

// `radius.composer` is a named exception to the radius ceiling, and its token
// says who may wear it: "the composer box alone — in New chat and in an open
// conversation". The Git pane's commit box shares the composer's MATERIAL
// (owner ruling 2026-10-01) but is not the composer, and a 22px corner there
// puts the square Commit button's corner outside the box's curve. So the
// material and the corner are two names, and only the two composers take the
// one with the corner.

const RENDERER = join(process.cwd(), 'src', 'renderer', 'src')

/**
 * The files allowed to draw the composer's corner: the token itself, the two
 * composers, and the strip both tuck under their box, whose lower corners are
 * `radius.composer-strip` — the same family, named for that one strip.
 */
const COMPOSERS = new Set([
  'components/ui/tokens.ts',
  'components/ui/index.ts',
  'components/workspace/agentComposer/NewAgentPanel.tsx',
  'components/workspace/agentComposer/ComposerStrip.tsx',
  'components/panels/AgentChatView.tsx',
])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** The source with its comments blanked, so a sentence that names the token is not a use of it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('the composer surface is the material plus the composer corner, and the material has no corner', () => {
  assert.ok(!/\brounded/.test(COMPOSER_MATERIAL_CLASS), 'the material draws no radius of its own')
  assert.match(COMPOSER_SURFACE_CLASS, /rounded-\[var\(--sem-radius-composer\)\]/)
  for (const part of COMPOSER_MATERIAL_CLASS.split(/\s+/)) {
    assert.ok(COMPOSER_SURFACE_CLASS.split(/\s+/).includes(part), `the composer surface carries ${part}`)
  }
})

test('only the two composers wear radius.composer', () => {
  const offenders: string[] = []
  for (const file of sources(RENDERER)) {
    const rel = relative(RENDERER, file).split('\\').join('/')
    if (COMPOSERS.has(rel)) continue
    const body = code(readFileSync(file, 'utf8'))
    if (/COMPOSER_SURFACE_CLASS|--sem-radius-composer\b/.test(body)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], 'a surface that is not the composer borrows its corner')
})
