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
const templateScript = join(templatesRoot, 'scripts', 'build-catalog.mjs')

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
function buildMutatedExample(mutate?: (root: string) => void): BuildResult & { html: () => string } {
  const root = mkdtempSync(join(tmpdir(), 'ds-build-catalog-'))
  try {
    cpSync(exampleRoot, root, { recursive: true })
    if (mutate) mutate(root)
    const result = runBuild(root)
    const html =
      result.status === 0 ? readFileSync(join(root, 'catalog', 'index.html'), 'utf8') : ''
    return { ...result, html: () => html }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

run('the example bundle carries the template verbatim (stamping is a copy)', () => {
  assert.equal(
    readFileSync(join(exampleRoot, 'scripts', 'build-catalog.mjs'), 'utf8'),
    readFileSync(templateScript, 'utf8'),
    'example scripts/build-catalog.mjs has drifted from the template',
  )
})

// --- Golden output ---------------------------------------------------------------

run('regenerating the example bundle reproduces the committed catalog byte-identically', () => {
  const committed = readFileSync(join(exampleRoot, 'catalog', 'index.html'), 'utf8')
  const built = buildMutatedExample()
  assert.equal(built.status, 0, built.stderr)
  assert.equal(built.html(), committed, 'generated catalog/index.html differs from the committed example')
})

run('running the script twice produces identical output (deterministic)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-build-catalog-det-'))
  try {
    cpSync(exampleRoot, root, { recursive: true })
    assert.equal(runBuild(root).status, 0)
    const first = readFileSync(join(root, 'catalog', 'index.html'), 'utf8')
    assert.equal(runBuild(root).status, 0)
    const second = readFileSync(join(root, 'catalog', 'index.html'), 'utf8')
    assert.equal(first, second)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Self-containment (the srcDoc iframe constraint) --------------------------------

run('the catalog is a single self-contained page: no scripts, links, or asset URLs', () => {
  const html = buildMutatedExample().html()
  assert.ok(html.startsWith('<!doctype html>\n<!-- GENERATED FILE'), 'must open with the generated banner')
  assert.ok(!/<script/i.test(html), 'catalog must not contain script tags')
  assert.ok(!/<link/i.test(html), 'catalog must not reference external stylesheets')
  assert.ok(!/\bsrc\s*=/i.test(html), 'catalog must not carry src= asset references')
  assert.ok(html.includes(':root {'), 'tokens.css must be inlined')
  assert.ok(html.includes('.ds-button {'), 'component.css must be inlined')
  assert.ok(html.includes('M4.5 12.5l5 5 10-11'), 'glyph SVG must be inlined as markup')
})

run('nav covers Foundations / Components / Patterns via CSS-only radio views', () => {
  const html = buildMutatedExample().html()
  for (const anchor of [
    'id="foundations"',
    'id="foundations-palette"',
    'id="foundations-glyphs"',
    'id="components"',
    'id="component-button"',
    'id="patterns"',
    'id="pattern-sign-in"',
  ]) {
    assert.ok(html.includes(anchor), `missing section anchor id ${anchor}`)
  }
  // Nav must NOT use fragment links: in the scripts-off srcDoc preview a
  // "#…" click navigates the sandboxed frame to the embedding app's URL
  // (fragments resolve against the parent base URL), and the
  // base=about:srcdoc workaround breaks the same links opened standalone.
  assert.ok(!/<a[\s>]/i.test(html), 'catalog must not contain link elements')
  assert.ok(
    html.includes('id="ds-view-foundations" checked'),
    'Foundations must be the default checked view',
  )
  assert.ok(html.includes('id="ds-view-component-button"'), 'missing component view radio')
  assert.ok(
    html.includes('<label class="catalog-nav-item" for="ds-view-component-button">'),
    'nav must label the component view radio',
  )
  assert.ok(
    html.includes('#ds-view-component-button:checked ~ .ds-catalog #component-button { display: block; }'),
    'missing the view-visibility rule for the component',
  )
})

run('the CSS-only mode toggle re-declares dark overrides and restores pinned-light islands', () => {
  const html = buildMutatedExample().html()
  assert.ok(html.includes('<input type="checkbox" id="ds-mode-dark" />'), 'missing toggle checkbox')
  const checkedRule = html.indexOf('#ds-mode-dark:checked ~ .ds-catalog {')
  assert.ok(checkedRule > 0, 'missing checked dark-override rule')
  assert.ok(
    html
      .slice(checkedRule)
      .includes('--sem-color-bg-app: var(--ref-color-neutral-950);'),
    'dark override values must be re-declared under the toggle',
  )
  assert.ok(
    html.includes('#ds-mode-dark:checked ~ .ds-catalog [data-mode="light"]'),
    'pinned-light demo islands must be restored under the toggle',
  )
})

run('demo and pattern page-level styles are scoped to their embed wrapper', () => {
  const html = buildMutatedExample().html()
  assert.ok(html.includes('.ds-embed-component-button {'), 'demo body styles must be rescoped')
  assert.ok(html.includes('.ds-embed-pattern-sign-in {'), 'pattern body styles must be rescoped')
  const scaffoldingStart = html.indexOf('Demo and pattern scaffolding')
  assert.ok(scaffoldingStart > 0, 'missing the scoped scaffolding style block')
  const scaffolding = html.slice(scaffoldingStart, html.indexOf('</style>', scaffoldingStart))
  assert.ok(
    !/(^|\n)\s*(body|html|:root)\b/.test(scaffolding),
    'embedded page-level selectors must be rewritten to the embed wrapper',
  )
})

// --- Contribution auto-appear --------------------------------------------------------

run('an added component directory surfaces on regeneration without manifest or hand edits', () => {
  const built = buildMutatedExample((root) => {
    cpSync(join(root, 'components', 'button'), join(root, 'components', 'chip'), {
      recursive: true,
    })
  })
  assert.equal(built.status, 0, built.stderr)
  assert.ok(built.html().includes('id="component-chip"'), 'new component dir must gain a section')
  assert.ok(
    built.html().includes('for="ds-view-component-chip"'),
    'new component dir must gain a nav entry',
  )
})

// --- Empty-state skeleton -------------------------------------------------------------

run('a bundle with no components produces a valid skeleton page, not an error', () => {
  const built = buildMutatedExample((root) => {
    rmSync(join(root, 'components'), { recursive: true })
    const manifestPath = join(root, 'design-system.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.contents.components = []
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  })
  assert.equal(built.status, 0, built.stderr)
  const html = built.html()
  assert.ok(html.startsWith('<!doctype html>'), 'skeleton must still be a full document')
  assert.ok(html.includes('id="components"'), 'skeleton keeps the Components section')
  assert.ok(html.includes('No components yet'), 'skeleton names the empty state')
  assert.ok(html.includes('id="foundations-palette"'), 'foundations still render in the skeleton')
})

// --- Failure paths --------------------------------------------------------------------

run('a missing derived tokens.css exits 2 and names build-tokens.mjs', () => {
  const result = buildMutatedExample((root) => {
    rmSync(join(root, 'foundations', 'tokens.css'))
  })
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('build-tokens.mjs'), result.stderr)
})

run('a component directory missing one of its three files fails loudly, naming it', () => {
  const result = buildMutatedExample((root) => {
    rmSync(join(root, 'components', 'button', 'component.md'))
  })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('components/button'), result.stderr)
  assert.ok(result.stderr.includes('component.md'), result.stderr)
})

run('a missing bundle manifest exits 2 (misconfiguration)', () => {
  const result = buildMutatedExample((root) => {
    rmSync(join(root, 'design-system.json'))
  })
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('design-system.json'), result.stderr)
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
  console.log('build-catalog.test.ts: ok')
}

main()
