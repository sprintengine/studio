import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const exampleRoot = join(process.cwd(), 'resources', 'design-system', 'example')
const templatesRoot = join(process.cwd(), 'resources', 'design-system', 'templates')
const templateScript = join(templatesRoot, 'scripts', 'build-tokens.mjs')

interface BuildResult {
  status: number | null
  stdout: string
  stderr: string
}

function runBuild(bundleRoot: string): BuildResult {
  const result = spawnSync(process.execPath, [templateScript, bundleRoot], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Copy the example bundle to a temp dir, optionally mutate it, build, inspect. */
function buildMutatedExample(mutate?: (root: string) => void): BuildResult & { css: () => string } {
  const root = mkdtempSync(join(tmpdir(), 'ds-build-tokens-'))
  try {
    cpSync(exampleRoot, root, { recursive: true })
    if (mutate) mutate(root)
    const result = runBuild(root)
    const css = readFileSync(join(root, 'foundations', 'tokens.css'), 'utf8')
    return { ...result, css: () => css }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mutateTokens(root: string, mutate: (tokens: any) => void): void {
  const tokensPath = join(root, 'foundations', 'tokens.tokens.json')
  const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'))
  mutate(tokens)
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2))
}

run('the example bundle carries the template verbatim (stamping is a copy)', () => {
  assert.equal(
    readFileSync(join(exampleRoot, 'scripts', 'build-tokens.mjs'), 'utf8'),
    readFileSync(templateScript, 'utf8'),
    'example scripts/build-tokens.mjs has drifted from the template',
  )
})

// --- Golden output ---------------------------------------------------------------

run('regenerating the example bundle reproduces the committed tokens.css byte-identically', () => {
  const committed = readFileSync(join(exampleRoot, 'foundations', 'tokens.css'), 'utf8')
  const built = buildMutatedExample()
  assert.equal(built.status, 0, built.stderr)
  assert.equal(built.css(), committed, 'generated tokens.css differs from the committed example')
})

run('running the script twice produces identical output (deterministic)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-build-tokens-det-'))
  try {
    cpSync(exampleRoot, root, { recursive: true })
    assert.equal(runBuild(root).status, 0)
    const first = readFileSync(join(root, 'foundations', 'tokens.css'), 'utf8')
    assert.equal(runBuild(root).status, 0)
    const second = readFileSync(join(root, 'foundations', 'tokens.css'), 'utf8')
    assert.equal(first, second)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Emission contract -------------------------------------------------------------

run('aliases resolve to var() references and literals emit as written', () => {
  const built = buildMutatedExample()
  const css = built.css()
  assert.ok(css.includes('--sem-color-bg-app: var(--ref-color-neutral-50);'), 'alias must emit var()')
  assert.ok(css.includes('--ref-color-neutral-50: #f7f5ef;'), 'color literal must emit as-is')
  assert.ok(css.includes('--ref-space-2: 8px;'), 'dimension literal must emit as-is')
  assert.ok(css.includes('--ref-font-weight-regular: 400;'), 'fontWeight number must emit as-is')
  assert.ok(
    css.includes('--ref-font-family-mono: "JetBrains Mono", SFMono-Regular, monospace;'),
    'fontFamily arrays join with commas, quoting names with spaces',
  )
})

run('emits a :root block with every token and a dark block with exactly the mode-varying tokens', () => {
  const built = buildMutatedExample()
  const css = built.css()
  const darkIndex = css.indexOf('\n[data-mode="dark"]')
  assert.ok(css.startsWith('/* GENERATED FILE'), 'output must open with the generated banner')
  assert.ok(css.includes(':root {'), 'missing :root block')
  assert.ok(darkIndex > 0, 'missing [data-mode="dark"] block')
  const lightBlock = css.slice(0, darkIndex)
  const darkBlock = css.slice(darkIndex)
  // Mode-invariant token appears only in :root; mode-varying token in both.
  assert.ok(lightBlock.includes('--sem-radius-control:'))
  assert.ok(!darkBlock.includes('--sem-radius-control:'), 'mode-invariant token leaked into dark block')
  assert.ok(lightBlock.includes('--sem-color-bg-app: var(--ref-color-neutral-50);'))
  assert.ok(darkBlock.includes('--sem-color-bg-app: var(--ref-color-neutral-950);'))
})

// --- Malformed-token error paths -----------------------------------------------------

run('an alias that resolves to nothing fails loudly, naming the token', () => {
  const result = buildMutatedExample((root) => {
    mutateTokens(root, (tokens: any) => {
      tokens.sem.color.text.primary.$value = '{ref.color.neutral.presence-of-typo}'
      tokens.sem.color.text.primary.$extensions['com.multicode'].modes.light =
        '{ref.color.neutral.presence-of-typo}'
    })
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('sem.color.text.primary'), result.stderr)
  assert.ok(result.stderr.includes('resolves to no token'), result.stderr)
})

run('a token missing its explicit $type fails loudly', () => {
  const result = buildMutatedExample((root) => {
    mutateTokens(root, (tokens: any) => {
      delete tokens.ref.space['1'].$type
    })
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('ref.space.1'), result.stderr)
  assert.ok(result.stderr.includes('$type'), result.stderr)
})

run('modes.light diverging from $value fails loudly (light is the default mode)', () => {
  const result = buildMutatedExample((root) => {
    mutateTokens(root, (tokens: any) => {
      tokens.sem.color.bg.app.$extensions['com.multicode'].modes.light = '{ref.color.neutral.0}'
    })
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('sem.color.bg.app'), result.stderr)
  assert.ok(result.stderr.includes('modes.light must equal $value'), result.stderr)
})

run('a missing tokens file exits 2 (misconfiguration, not a malformed token)', () => {
  const result = buildMutatedExample((root) => {
    rmSync(join(root, 'foundations', 'tokens.tokens.json'))
  })
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('tokens.tokens.json'), result.stderr)
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
  console.log('build-tokens.test.ts: ok')
}

main()
