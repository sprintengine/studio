import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emitTokensCss,
  isColorValue,
  parseTokenDocument,
  resolveAccentColor,
  resolveFontFamilies,
  resolveTokenValue,
} from './tokens-css'
import { test } from 'vitest'

test('tokens-css', async () => {
  // THE DRIFT GUARD. `emitTokensCss` is a second implementation of the emission
  // the bundle's own `scripts/build-tokens.mjs` performs — allowed only because the
  // door writes nothing and needs the variables in memory for a scripts-off
  // iframe. This test is what stops the two from diverging: it runs the real
  // template generator over the real example bundle and asserts BYTE equality with
  // the TypeScript emitter. Change either one and this fails, which is the point.

  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')
  const templateScript = join(process.cwd(), 'resources', 'design-system', 'templates', 'scripts', 'build-tokens.mjs')

  /** Copy the example bundle, optionally mutate its tokens, run the generator. */
  function generate(mutate?: (tokens: Record<string, any>) => void): {
    generated: string
    document: unknown
  } {
    const root = mkdtempSync(join(tmpdir(), 'ds-tokens-css-'))
    try {
      cpSync(exampleRoot, root, { recursive: true })
      const tokensPath = join(root, 'foundations', 'tokens.tokens.json')
      if (mutate) {
        const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, any>
        mutate(tokens)
        writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`)
      }
      const result = spawnSync(process.execPath, [templateScript, root], { encoding: 'utf8' })
      assert.equal(result.status, 0, `generator failed: ${result.stderr}`)
      return {
        generated: readFileSync(join(root, 'foundations', 'tokens.css'), 'utf8'),
        document: JSON.parse(readFileSync(tokensPath, 'utf8')),
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  run('emitTokensCss is byte-identical to the bundle’s own generator', () => {
    const { generated, document } = generate()
    const emitted = emitTokensCss(document)
    assert.deepEqual(emitted.problems, [], 'a valid bundle emits no problems')
    assert.equal(
      emitted.css,
      generated,
      'the TS emitter drifted from scripts/build-tokens.mjs — reconcile them, do not relax this test',
    )
  })

  run('still byte-identical after the tokens change (aliases, modes, fontFamily)', () => {
    // Exercise the three value forms the contract covers, so equality is not an
    // accident of the example's current content.
    const { generated, document } = generate((tokens) => {
      // A literal, an alias, a mode-varying pair, and a fontFamily array.
      tokens.ref.color.green['600'].$value = '#0a0b0c'
      tokens.sem.color.accent.primary.$extensions['com.sprintengine'].modes = {
        light: '{ref.color.green.600}',
        dark: '{ref.color.green.500}',
      }
      tokens.sem.color.accent.primary.$value = '{ref.color.green.600}'
      tokens.sem.font = tokens.sem.font ?? {}
      tokens.sem.font.family = tokens.sem.font.family ?? {}
      tokens.sem.font.family.ui = {
        $type: 'fontFamily',
        $value: ['Inter Tight', 'system-ui'],
        $description: 'UI face.',
        $extensions: { 'com.sprintengine': { role: 'font', use: 'App chrome.' } },
      }
    })
    const emitted = emitTokensCss(document)
    assert.deepEqual(emitted.problems, [])
    assert.equal(emitted.css, generated)
    // The quoting rule the contract fixes: a family with whitespace is quoted.
    assert.match(emitted.css, /--sem-font-family-ui: "Inter Tight", system-ui;/)
  })

  run('dark overrides carry only the tokens whose dark value differs', () => {
    const { document } = generate()
    const { css } = emitTokensCss(document)
    // The header comment mentions both selectors, so anchor on the real blocks:
    // each selector at the start of a line.
    const rootStart = css.indexOf('\n:root {\n') + 1
    const darkStart = css.indexOf('\n[data-mode="dark"] {\n') + 1
    assert.ok(rootStart > 0 && darkStart > rootStart, 'both blocks are present, in order')
    const root = css.slice(rootStart, darkStart)
    const dark = css.slice(darkStart)
    const darkVars = [...dark.matchAll(/^ {2}(--[\w-]+):/gm)].map((match) => match[1])
    const rootVars = [...root.matchAll(/^ {2}(--[\w-]+):/gm)].map((match) => match[1])
    assert.ok(darkVars.length > 0, 'the example declares mode-varying tokens')
    assert.ok(darkVars.length < rootVars.length, 'and dark re-declares only some of them')
    for (const name of darkVars) assert.ok(rootVars.includes(name), `${name} is declared in :root too`)
  })

  run('a malformed token costs its own variable, not the whole preview', () => {
    // The generator EXITS on these; the door reports and renders the rest, because
    // refusing to draw a bundle is the author's gate, not a viewer's.
    const { document } = generate()
    const doc = document as Record<string, any>
    doc.sem.color.accent.primary.$value = '{ref.color.nope}'
    doc.sem.color.accent.primary.$extensions['com.sprintengine'].modes = {
      light: '{ref.color.nope}',
      dark: '{ref.color.nope}',
    }
    const { css, problems } = emitTokensCss(doc)
    assert.ok(
      problems.some((problem) => problem.includes('resolves to no token')),
      problems.join('; '),
    )
    assert.ok(!css.includes('--sem-color-accent-primary:'), 'the broken token emits nothing')
    assert.match(css, /--sem-color-bg-app:/, 'and every other token still emits')
  })

  run('an empty document is a problem, not an empty stylesheet passed off as valid', () => {
    const { css, problems } = emitTokensCss({})
    assert.equal(css, '')
    assert.equal(problems.length, 1)
  })

  // ── Resolution (the rail's accent, the specimen's faces) ─────────────────────

  run('resolveTokenValue follows alias chains and refuses cycles', () => {
    const document = {
      ref: {
        a: { $type: 'color', $value: '{ref.b}' },
        b: { $type: 'color', $value: '#abcdef' },
        loop: { $type: 'color', $value: '{ref.loop2}' },
        loop2: { $type: 'color', $value: '{ref.loop}' },
      },
    }
    assert.equal(resolveTokenValue(document, 'ref.a', 'light'), '#abcdef')
    assert.equal(resolveTokenValue(document, 'ref.loop', 'light'), null, 'a cycle terminates')
    assert.equal(resolveTokenValue(document, 'ref.missing', 'light'), null)
    assert.equal(resolveTokenValue(null, 'ref.a', 'light'), null)
  })

  run('the accent is refused unless it is really a colour', () => {
    const document = {
      sem: { color: { accent: { primary: { $type: 'color', $value: 'javascript:alert(1)' } } } },
    }
    assert.equal(resolveAccentColor(document, 'light'), null, 'token docs are third-party content')
    assert.equal(isColorValue('#2f6a4a'), true)
    assert.equal(isColorValue('rgba(47, 106, 74, 0.10)'), true)
    assert.equal(isColorValue('url(evil)'), false)
    assert.equal(isColorValue('red; background: url(x)'), false)
  })

  run('a fontFamily ARRAY resolves to a CSS family list, quoted where it must be', () => {
    // DTCG fontFamily values are arrays, not strings — the specimen showed our
    // font instead of the bundle's until this was handled.
    const document = {
      sem: {
        font: {
          family: {
            ui: { $type: 'fontFamily', $value: ['Inter', 'SF Pro Text', 'sans-serif'] },
            mono: { $type: 'fontFamily', $value: ['JetBrains Mono', 'monospace'] },
          },
        },
      },
    }
    assert.deepEqual(resolveFontFamilies(document), {
      ui: 'Inter, "SF Pro Text", sans-serif',
      mono: '"JetBrains Mono", monospace',
    })
  })

  run('a bundle declaring no families resolves to null rather than to ours', () => {
    assert.deepEqual(resolveFontFamilies({}), { ui: null, mono: null })
    // A single-string family (some bundles author it that way) still resolves.
    assert.equal(
      resolveFontFamilies({ sem: { font: { family: { ui: { $type: 'fontFamily', $value: 'Inter' } } } } }).ui,
      'Inter',
    )
  })

  run('parseTokenDocument refuses non-objects instead of throwing', () => {
    assert.equal(parseTokenDocument('{ not json'), null)
    assert.equal(parseTokenDocument('[]'), null)
    assert.deepEqual(parseTokenDocument('{"a":1}'), { a: 1 })
  })

  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('tokens-css.test.ts: ok')
})
