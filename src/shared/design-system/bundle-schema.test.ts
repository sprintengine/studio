import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_SYSTEM_MANIFEST_FILENAME, parseDesignSystemManifest } from './manifest'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const bundleRoot = join(process.cwd(), 'resources', 'design-system', 'example')
const manifestJson = readFileSync(join(bundleRoot, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
const manifest = parseDesignSystemManifest(manifestJson)

// --- DTCG token walking -----------------------------------------------------

interface DtcgToken {
  path: string
  node: Record<string, unknown>
}

const VENDOR_NAMESPACE = 'com.multicode'
const ALIAS_PATTERN = /^\{([a-z0-9.-]+)\}$/
const SEGMENT_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
const PX_DIMENSION_PATTERN = /^-?\d+(\.\d+)?px$/

function collectTokens(node: unknown, path: string[], out: DtcgToken[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  const record = node as Record<string, unknown>
  if ('$value' in record) {
    out.push({ path: path.join('.'), node: record })
    return
  }
  for (const [key, child] of Object.entries(record)) {
    assert.ok(
      SEGMENT_PATTERN.test(key),
      `token group segment "${key}" violates the naming grammar at ${path.join('.')}`,
    )
    collectTokens(child, [...path, key], out)
  }
}

const tokensJson = JSON.parse(readFileSync(join(bundleRoot, 'foundations', 'tokens.tokens.json'), 'utf8'))
const tokens: DtcgToken[] = []
collectTokens(tokensJson, [], tokens)
const tokensByPath = new Map(tokens.map((token) => [token.path, token]))

function vendorExtension(token: DtcgToken): Record<string, unknown> | null {
  const extensions = token.node.$extensions
  if (typeof extensions !== 'object' || extensions === null) return null
  const vendor = (extensions as Record<string, unknown>)[VENDOR_NAMESPACE]
  return typeof vendor === 'object' && vendor !== null ? (vendor as Record<string, unknown>) : null
}

function assertValueResolves(value: unknown, context: string): void {
  if (typeof value !== 'string') return
  const alias = ALIAS_PATTERN.exec(value)
  if (!alias) return
  assert.ok(tokensByPath.has(alias[1]), `${context}: alias ${value} does not resolve to a token`)
}

function tokenModes(token: DtcgToken): Record<string, unknown> | null {
  const vendor = vendorExtension(token)
  const modes = vendor?.modes
  return typeof modes === 'object' && modes !== null ? (modes as Record<string, unknown>) : null
}

const modeVaryingTokens = tokens.filter((token) => {
  const modes = tokenModes(token)
  return modes !== null && JSON.stringify(modes.light) !== JSON.stringify(modes.dark)
})

// --- Manifest ----------------------------------------------------------------

run('manifest validates and carries schemaVersion, version, and provenance', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.name, 'example')
  assert.ok(manifest.version.length > 0)
  assert.deepEqual([...manifest.modes].sort(), ['dark', 'light'])
  assert.ok('sourceLibraryId' in manifest.provenance)
  assert.ok('releasedAt' in manifest.provenance)
  assert.ok('attachedAt' in manifest.provenance)
})

run('unknown manifest fields are preserved on read', () => {
  const raw = JSON.parse(manifestJson) as Record<string, unknown>
  raw['x-future-field'] = { nested: true }
  const reparsed = parseDesignSystemManifest(JSON.stringify(raw))
  assert.deepEqual(reparsed['x-future-field'], { nested: true })
})

run('manifest parsing rejects structurally invalid manifests', () => {
  assert.throws(() => parseDesignSystemManifest('{'), /not valid JSON/)
  const withoutVersion = JSON.parse(manifestJson) as Record<string, unknown>
  delete withoutVersion.schemaVersion
  assert.throws(() => parseDesignSystemManifest(JSON.stringify(withoutVersion)), /schemaVersion/)
  const badModes = JSON.parse(manifestJson) as Record<string, unknown>
  badModes.modes = ['light']
  assert.throws(() => parseDesignSystemManifest(JSON.stringify(badModes)), /modes/)
})

run('every contents entry points at a real file in the bundle', () => {
  const contents = manifest.contents
  for (const entry of [...contents.foundations, ...contents.patterns, ...contents.glyphs, ...contents.assets]) {
    assert.ok(existsSync(join(bundleRoot, entry)), `contents entry missing on disk: ${entry}`)
  }
  for (const component of contents.components) {
    for (const file of ['component.html', 'component.css', 'component.md']) {
      const path = join(bundleRoot, 'components', component, file)
      assert.ok(existsSync(path), `component "${component}" is missing ${file}`)
    }
  }
})

run('derived files that exist carry the generated banner and never appear in contents', () => {
  const authored = new Set([
    ...manifest.contents.foundations,
    ...manifest.contents.patterns,
    ...manifest.contents.glyphs,
  ])
  const derivedPaths = Object.keys(manifest.derived)
  assert.ok(derivedPaths.includes('foundations/tokens.css'))
  assert.ok(derivedPaths.includes('catalog/index.html'))
  for (const derived of derivedPaths) {
    assert.ok(!authored.has(derived), `derived file also listed as authored content: ${derived}`)
    const path = join(bundleRoot, derived)
    if (!existsSync(path)) continue
    const head = readFileSync(path, 'utf8').slice(0, 200)
    assert.ok(/GENERATED/i.test(head), `derived file lacks a generated banner: ${derived}`)
  }
  assert.ok(
    existsSync(join(bundleRoot, 'foundations', 'tokens.css')),
    'foundations/tokens.css must ship in the example',
  )
})

// --- Tokens -------------------------------------------------------------------

run('token file parses as DTCG: explicit $type, valid $value forms, resolving aliases', () => {
  assert.ok(tokens.length > 0, 'no tokens found')
  for (const token of tokens) {
    const { $type, $value } = token.node
    assert.equal(typeof $type, 'string', `${token.path}: missing explicit $type`)
    assert.ok($value !== undefined, `${token.path}: missing $value`)
    assertValueResolves($value, token.path)
    if (typeof $value === 'string' && !ALIAS_PATTERN.test($value)) {
      if ($type === 'color')
        assert.ok(HEX_COLOR_PATTERN.test($value), `${token.path}: color literal must be lowercase hex, got ${$value}`)
      if ($type === 'dimension')
        assert.ok(
          PX_DIMENSION_PATTERN.test($value),
          `${token.path}: dimension literal must be a px string, got ${$value}`,
        )
    }
    if ($type === 'fontWeight' && typeof $value === 'number') {
      assert.ok($value >= 1 && $value <= 1000, `${token.path}: fontWeight out of range`)
    }
  }
})

run('token paths follow the two-tier grammar (ref + sem only)', () => {
  for (const token of tokens) {
    const tier = token.path.split('.')[0]
    assert.ok(tier === 'ref' || tier === 'sem', `${token.path}: tier must be ref or sem`)
  }
})

run('every token carries a $description; every semantic token carries vendor semantics', () => {
  for (const token of tokens) {
    const description = token.node.$description
    assert.ok(typeof description === 'string' && description.trim().length > 0, `${token.path}: missing $description`)
    if (!token.path.startsWith('sem.')) continue
    const vendor = vendorExtension(token)
    assert.ok(vendor, `${token.path}: semantic token missing $extensions["${VENDOR_NAMESPACE}"]`)
    assert.ok(typeof vendor?.role === 'string' && vendor.role.length > 0, `${token.path}: missing semantic role`)
    assert.ok(typeof vendor?.use === 'string' && vendor.use.length > 0, `${token.path}: missing semantic use`)
  }
})

run('mode-carrying tokens declare exactly light and dark, with light matching $value', () => {
  let modeCarrying = 0
  for (const token of tokens) {
    const modes = tokenModes(token)
    if (!modes) continue
    modeCarrying += 1
    assert.deepEqual(
      Object.keys(modes).sort(),
      ['dark', 'light'],
      `${token.path}: modes must be exactly light and dark`,
    )
    assert.deepEqual(
      modes.light,
      token.node.$value,
      `${token.path}: modes.light must equal $value (light is the default mode)`,
    )
    assertValueResolves(modes.light, `${token.path} modes.light`)
    assertValueResolves(modes.dark, `${token.path} modes.dark`)
  }
  assert.ok(modeCarrying > 0, 'example bundle must exercise the mode convention')
  assert.ok(modeVaryingTokens.length > 0, 'example bundle must contain tokens that differ between light and dark')
})

run('a seeded starter output validates like from-scratch output', () => {
  // Seed-from-existing-product (T10) marks every inferred semantic with
  // `"seeded": true` inside the vendor extension until the user confirms it.
  // The schema treats that as an ordinary extra vendor field: every invariant
  // that holds for the from-scratch example holds unchanged for the seeded shape.
  const seededJson = JSON.parse(JSON.stringify(tokensJson)) as Record<string, unknown>
  const seededTokens: DtcgToken[] = []
  collectTokens(seededJson, [], seededTokens)
  let marked = 0
  for (const token of seededTokens) {
    if (!token.path.startsWith('sem.')) continue
    const vendor = vendorExtension(token)
    assert.ok(vendor, `${token.path}: semantic token missing vendor extension`)
    vendor.seeded = true
    marked += 1
  }
  assert.ok(marked > 0, 'seeded shape must mark at least one semantic token')
  for (const token of seededTokens) {
    assert.equal(typeof token.node.$type, 'string', `${token.path}: seeded token missing explicit $type`)
    const description = token.node.$description
    assert.ok(
      typeof description === 'string' && description.trim().length > 0,
      `${token.path}: seeded token missing $description`,
    )
    if (!token.path.startsWith('sem.')) continue
    const vendor = vendorExtension(token)
    assert.ok(
      typeof vendor?.role === 'string' && vendor.role.length > 0,
      `${token.path}: seeded token lost its semantic role`,
    )
    assert.ok(
      typeof vendor?.use === 'string' && vendor.use.length > 0,
      `${token.path}: seeded token lost its semantic use`,
    )
    assert.equal(vendor?.seeded, true, `${token.path}: seeded marker must survive alongside the semantics`)
    const modes = vendor?.modes
    if (typeof modes === 'object' && modes !== null) {
      assert.deepEqual(
        Object.keys(modes as Record<string, unknown>).sort(),
        ['dark', 'light'],
        `${token.path}: seeded shape must keep the light/dark mode convention`,
      )
    }
  }
})

// --- Derived tokens.css --------------------------------------------------------

run('tokens.css defines every token as a custom property and overrides mode-varying tokens in the dark block', () => {
  const css = readFileSync(join(bundleRoot, 'foundations', 'tokens.css'), 'utf8')
  const darkIndex = css.indexOf('\n[data-mode="dark"]')
  assert.ok(css.includes(':root'), 'tokens.css must define a :root (light) block')
  assert.ok(darkIndex > 0, 'tokens.css must define a [data-mode="dark"] block')
  const lightBlock = css.slice(0, darkIndex)
  const darkBlock = css.slice(darkIndex)
  for (const token of tokens) {
    const cssVar = `--${token.path.replace(/\./g, '-')}`
    assert.ok(lightBlock.includes(`${cssVar}:`), `tokens.css :root is missing ${cssVar}`)
  }
  const darkVars = new Set([...darkBlock.matchAll(/(--[a-z0-9-]+):/g)].map((match) => match[1]))
  const expectedDarkVars = new Set(modeVaryingTokens.map((token) => `--${token.path.replace(/\./g, '-')}`))
  assert.deepEqual(darkVars, expectedDarkVars, 'dark block must contain exactly the mode-varying tokens')
})

// --- Components, portability, glyphs -------------------------------------------

run('component docs follow the anatomy/variants/states/usage/accessibility template', () => {
  for (const component of manifest.contents.components) {
    const doc = readFileSync(join(bundleRoot, 'components', component, 'component.md'), 'utf8')
    for (const heading of ['## Anatomy', '## Variants', '## States', '## Usage', '## Accessibility']) {
      assert.ok(doc.includes(heading), `components/${component}/component.md is missing "${heading}"`)
    }
  }
})

run('component and pattern CSS consume only semantic variables, never --ref-*', () => {
  const sources = [
    ...manifest.contents.components.flatMap((component) => [
      join(bundleRoot, 'components', component, 'component.css'),
      join(bundleRoot, 'components', component, 'component.html'),
    ]),
    ...manifest.contents.patterns.map((pattern) => join(bundleRoot, pattern)),
  ]
  for (const source of sources) {
    const content = readFileSync(source, 'utf8')
    assert.ok(!/var\(--ref-/.test(content), `${source} references an internal --ref-* variable`)
  }
})

run('the portability stanza points at real files in the bundle', () => {
  const stanza = readFileSync(join(bundleRoot, 'AGENTS.md'), 'utf8')
  for (const target of ['USAGE.md', 'foundations/tokens.css', 'components/']) {
    assert.ok(stanza.includes(target), `AGENTS.md stanza does not point at ${target}`)
  }
  assert.ok(existsSync(join(bundleRoot, 'USAGE.md')), 'USAGE.md missing')
  assert.ok(existsSync(join(bundleRoot, 'foundations', 'tokens.css')), 'foundations/tokens.css missing')
})

run('glyphs are themeable SVGs (currentColor, viewBox)', () => {
  for (const glyph of manifest.contents.glyphs) {
    const svg = readFileSync(join(bundleRoot, glyph), 'utf8')
    assert.ok(svg.trimStart().startsWith('<svg'), `${glyph} is not an SVG document`)
    assert.ok(svg.includes('viewBox'), `${glyph} is missing a viewBox`)
    assert.ok(svg.includes('currentColor'), `${glyph} must draw with currentColor`)
    assert.ok(!/#[0-9a-fA-F]{3,8}[\s"']/.test(svg), `${glyph} hard-codes a color literal`)
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
  console.log('bundle-schema.test.ts: ok')
}

main()
