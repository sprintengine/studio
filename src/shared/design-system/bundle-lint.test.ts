import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')
const templatesRoot = join(process.cwd(), 'resources', 'design-system', 'templates')
const templateLint = join(templatesRoot, 'scripts', 'lint.mjs')

interface LintResult {
  status: number | null
  stdout: string
  stderr: string
}

function runLint(bundleRoot: string, ...flags: string[]): LintResult {
  const result = spawnSync(process.execPath, [templateLint, bundleRoot, ...flags], {
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Copy the example bundle to a temp dir, mutate it, lint it, clean up. */
function lintMutatedExample(mutate: (root: string) => void, ...flags: string[]): LintResult {
  const root = mkdtempSync(join(tmpdir(), 'ds-lint-fixture-'))
  try {
    cpSync(exampleRoot, root, { recursive: true })
    mutate(root)
    return runLint(root, ...flags)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function appendToButtonCss(root: string, css: string): void {
  const path = join(root, 'components', 'button', 'component.css')
  writeFileSync(path, readFileSync(path, 'utf8') + css)
}

// --- Template ↔ example parity -------------------------------------------------

run('the example bundle carries the templates verbatim (stamping is a copy)', () => {
  for (const file of ['USAGE.md', join('scripts', 'lint.mjs')]) {
    assert.equal(
      readFileSync(join(exampleRoot, file), 'utf8'),
      readFileSync(join(templatesRoot, file), 'utf8'),
      `example ${file} has drifted from the template`,
    )
  }
})

// --- USAGE.md contract ----------------------------------------------------------

run('USAGE.md names the lint and regeneration scripts as runnable commands', () => {
  const usage = readFileSync(join(templatesRoot, 'USAGE.md'), 'utf8')
  for (const command of [
    'node scripts/lint.mjs',
    'node scripts/build-tokens.mjs',
    'node scripts/build-catalog.mjs',
  ]) {
    assert.ok(usage.includes(command), `USAGE.md does not name the command: ${command}`)
  }
})

run('USAGE.md covers consume, contribute, framework adaptation, naming grammar, allow marker', () => {
  const usage = readFileSync(join(templatesRoot, 'USAGE.md'), 'utf8')
  for (const heading of ['## Consume', '## Contribute', '## Adapt to your framework']) {
    assert.ok(usage.includes(heading), `USAGE.md is missing "${heading}"`)
  }
  assert.ok(/Tailwind/.test(usage), 'USAGE.md is missing the Tailwind mapping note')
  assert.ok(usage.includes('namingGrammar'), 'USAGE.md does not reference the naming grammar')
  assert.ok(usage.includes('ds-lint-allow:'), 'USAGE.md does not document the lint allow marker')
  assert.ok(/free append \+ mandatory lint/.test(usage), 'USAGE.md does not state the contribution gate')
})

// --- Lint pass/fail fixtures ------------------------------------------------------

run('lint passes on the example bundle', () => {
  const result = runLint(exampleRoot)
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`)
  assert.ok(result.stdout.includes('Total violations: 0'))
})

run('lint fails on a component with a raw hex color', () => {
  const result = lintMutatedExample((root) => {
    appendToButtonCss(root, '\n.ds-button--rogue { background: #ff0000; }\n')
  })
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes('no-raw-hex'), result.stdout)
  assert.ok(result.stdout.includes('components/button/component.css'), result.stdout)
})

run('lint fails on an untokenized color function', () => {
  const result = lintMutatedExample((root) => {
    appendToButtonCss(root, '\n.ds-button--rogue { color: rgb(255, 0, 0); }\n')
  })
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes('no-untokenized-color'), result.stdout)
})

run('lint fails when a component reaches into the --ref-* tier', () => {
  const result = lintMutatedExample((root) => {
    appendToButtonCss(root, '\n.ds-button--rogue { color: var(--ref-color-neutral-800); }\n')
  })
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes('no-ref-variables'), result.stdout)
})

run('a ds-lint-allow marker with a reason suppresses a source finding', () => {
  const result = lintMutatedExample((root) => {
    appendToButtonCss(
      root,
      '\n/* ds-lint-allow: fixture — un-tokenizable scrim literal */\n.ds-button--scrim { background: #00000080; }\n',
    )
  })
  assert.equal(result.status, 0, result.stdout)
})

run('lint fails on a sem token missing semantic $extensions metadata', () => {
  const result = lintMutatedExample((root) => {
    const tokensPath = join(root, 'foundations', 'tokens.tokens.json')
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'))
    tokens.sem.color.status.warning = {
      $type: 'color',
      $value: '{ref.color.green.500}',
      $description: 'Fixture token added without vendor semantics.',
    }
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2))
  })
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes('missing-token-semantics'), result.stdout)
  assert.ok(result.stdout.includes('sem.color.status.warning'), result.stdout)
})

run('lint fails on a token whose alias resolves to nothing', () => {
  const result = lintMutatedExample((root) => {
    const tokensPath = join(root, 'foundations', 'tokens.tokens.json')
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'))
    tokens.ref.color.neutral['300'] = {
      $type: 'color',
      $value: '{ref.color.neutral.presence-of-typo}',
      $description: 'Fixture token with a broken alias.',
    }
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2))
  })
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes('unresolved-token-alias'), result.stdout)
})

run('--report reports findings without failing', () => {
  const result = lintMutatedExample((root) => {
    appendToButtonCss(root, '\n.ds-button--rogue { background: #ff0000; }\n')
  }, '--report')
  assert.equal(result.status, 0, result.stdout)
  assert.ok(result.stdout.includes('no-raw-hex'), result.stdout)
})

run('lint exits 2 on a bundle missing its tokens file (misconfiguration, not pass)', () => {
  const result = lintMutatedExample((root) => {
    unlinkSync(join(root, 'foundations', 'tokens.tokens.json'))
  })
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('tokens.tokens.json'), result.stderr)
})

run('lint exits 2 when pointed at a directory that is not a bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-lint-not-a-bundle-'))
  try {
    const result = runLint(root)
    assert.equal(result.status, 2)
    assert.ok(result.stderr.includes('design-system.json'), result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('bundle-lint.test.ts: ok')
}

main()
