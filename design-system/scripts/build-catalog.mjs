#!/usr/bin/env node
// Live-catalog generator. Regenerates catalog/index.html — the single-file,
// self-contained catalog of the whole bundle — from the manifest, tokens,
// components, patterns, and glyphs. The derived file is never hand-edited.
// Dependency-free Node ESM (Node >= 18 stdlib only) so any agent, in any repo,
// regenerates with the same implementation that ships with the bundle:
//
//   node scripts/build-catalog.mjs           # from the bundle root
//   node scripts/build-catalog.mjs <bundle>  # explicit bundle root
//
// Emission contract (USAGE.md; stable per design-system.json schemaVersion):
//   - one HTML file, zero external references: tokens.css, component CSS,
//     demo markup, and SVG glyphs are inlined at generation time. No <script>
//     tags — the target preview is a sandboxed srcDoc iframe with scripts off,
//     where cross-file links and relative asset URLs do not resolve.
//   - CSS-only nav: Foundations / Components / Patterns, max 3 levels. Nav
//     items are labels for visually hidden radios that show the selected
//     view — NOT href="#…" fragment links. Fragment navigation is broken in
//     a srcdoc document: "#x" resolves against the parent page's base URL,
//     so a click navigates the sandboxed frame to the embedding app's URL
//     (verified under sandbox=""), and the <base href="about:srcdoc">
//     workaround breaks the same links when the file is opened directly in
//     a browser. Radio-driven views work in both contexts with scripts off.
//     Sections keep stable id anchors for contexts with real URLs.
//   - CSS-only light/dark toggle: a visually hidden checkbox before the
//     catalog root re-declares the dark token overrides via a sibling
//     combinator; [data-mode] islands inside demos keep their forced mode.
//   - per-file demo/pattern <style> blocks are scoped to their embed wrapper
//     (html/body/:root selectors are rewritten to it); component.css is
//     inlined unscoped — it is the real source consumers load.
//   - an empty contents section renders an empty-state skeleton, not an error.
//
// Output is a pure function of the bundle files — no timestamps, no
// environment — so repeated runs are byte-identical. foundations/tokens.css is
// inlined verbatim: run scripts/build-tokens.mjs first after token edits.
// Malformed inputs fail loudly (exit 1, offending path on stderr); a
// missing/invalid bundle or missing derived tokens.css exits 2.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VENDOR_NAMESPACE = 'com.multicode'

class BuildFailure extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

function fail(message, code = 1) {
  throw new BuildFailure(message, code)
}

// Exit via stream flush: under Electron utilityProcess the parent IPC port
// keeps the event loop alive (the script never exits on its own) and a bare
// process.exit() truncates buffered pipe output. Flushing both stdio streams
// before the hard exit is correct under plain `node` too.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Component directory names and pattern file stems become CSS class names on
// their embed wrappers (.ds-embed-component-<name>), used verbatim in both the
// class attribute and the scoped-stylesheet selector. Assert the manifest's
// kebab-case naming grammar at read time so the two can never diverge.
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function assertEmbedName(name, sourceLabel) {
  if (!KEBAB_CASE.test(name)) {
    fail(
      `${sourceLabel}: "${name}" is not kebab-case ([a-z0-9] segments joined by "-") — it becomes an embed CSS class name`,
    )
  }
}

// --- Tokens ----------------------------------------------------------------------

function collectTokens(node, path, out) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  if ('$value' in node) {
    out.push({ path: path.join('.'), node })
    return out
  }
  for (const [key, child] of Object.entries(node)) collectTokens(child, [...path, key], out)
  return out
}

function cssVariableName(tokenPath) {
  return `--${tokenPath.replace(/\./g, '-')}`
}

function tokenVendor(token) {
  const extensions = token.node.$extensions
  const vendor = typeof extensions === 'object' && extensions !== null ? extensions[VENDOR_NAMESPACE] : undefined
  return typeof vendor === 'object' && vendor !== null ? vendor : null
}

function tokenIsModeVarying(token) {
  const vendor = tokenVendor(token)
  const modes = vendor && typeof vendor.modes === 'object' && vendor.modes !== null ? vendor.modes : null
  return modes !== null && JSON.stringify(modes.dark) !== JSON.stringify(modes.light)
}

function displayValue(value) {
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

// tokens.css is a sibling derived file with a pinned emission contract:
// `:root { … }` then `[data-mode="dark"] { … }`, one `  --name: value;` line
// per token. Parse it back so the mode toggle can re-declare the same values.
function parseTokensCss(css) {
  const declPattern = /^\s*(--[A-Za-z0-9_-]+):\s*(.+);\s*$/
  const light = []
  const dark = []
  let target = null
  for (const line of css.split('\n')) {
    if (line.startsWith(':root')) {
      target = light
      continue
    }
    if (line.startsWith('[data-mode="dark"]')) {
      target = dark
      continue
    }
    if (line.startsWith('}')) {
      target = null
      continue
    }
    const declaration = target === null ? null : declPattern.exec(line)
    if (declaration) target.push({ name: declaration[1], value: declaration[2] })
  }
  return { light, dark }
}

// --- CSS scoping ------------------------------------------------------------------

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function splitTopLevel(text, separator) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    if (char === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function splitRules(css) {
  const rules = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const prelude = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    rules.push({ prelude, body: css.slice(open + 1, j - 1) })
    i = j
  }
  return rules
}

function scopeSelector(selector, scope) {
  const trimmed = selector.trim()
  if (trimmed === '') return scope
  if (trimmed.startsWith(':root')) return `${scope}${trimmed.slice(':root'.length)}`
  const rewritten = trimmed.replace(/^(html|body)(?![\w-])/, scope)
  if (rewritten !== trimmed) return rewritten
  return `${scope} ${trimmed}`
}

// A demo/pattern authored as a full-viewport page (body { min-height: 100vh })
// would force a viewport-tall embed stage in the catalog — a screenful of dead
// space between the view heading and the source disclosure. Clamp
// viewport-height minimums when the page CSS is rescoped onto its embed
// wrapper; values already wrapped in min() are left alone.
function clampViewportMinHeight(body) {
  return body.replace(/(min-height\s*:\s*)([^;}]*)/gi, (match, property, value) => {
    if (!/\b\d+(?:\.\d+)?vh\b/.test(value) || value.includes('min(')) return match
    return `${property}min(${value.trim()}, 480px)`
  })
}

// Scope a demo/pattern stylesheet to its embed wrapper so page-level selectors
// (html, body, :root) style the wrapper instead of the catalog document, and
// everything else applies only inside the wrapper.
function scopeCss(css, scope) {
  const out = []
  for (const rule of splitRules(stripCssComments(css))) {
    if (rule.prelude === '') continue
    if (rule.prelude.startsWith('@')) {
      if (/^@(media|supports|container)\b/.test(rule.prelude)) {
        out.push(`${rule.prelude} {\n${scopeCss(rule.body, scope)}\n}`)
      } else {
        // @keyframes, @font-face, … — selector-free bodies, keep verbatim.
        out.push(`${rule.prelude} {${rule.body}}`)
      }
      continue
    }
    const selectors = splitTopLevel(rule.prelude, ',').map((selector) => scopeSelector(selector, scope))
    out.push(`${selectors.join(', ')} {${clampViewportMinHeight(rule.body)}}`)
  }
  return out.join('\n')
}

// --- HTML embed extraction ----------------------------------------------------------

const STYLE_TAG_PATTERN = /<style[^>]*>[\s\S]*?<\/style>/gi
const SCRIPT_TAG_PATTERN = /<script[^>]*>[\s\S]*?<\/script>/gi

// Pull the embeddable pieces out of a standalone demo/pattern document: its
// <style> blocks (to be scoped) and its <body> markup. <link> tags live in
// <head> and are dropped with it (the catalog inlines tokens.css and component
// CSS itself); <style>/<script> tags are stripped from the markup — the
// catalog is script-free by contract.
function extractEmbeddable(html, sourceLabel) {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (!bodyMatch) fail(`${sourceLabel}: no <body> element to embed`)
  const styles = []
  for (const match of html.matchAll(STYLE_TAG_PATTERN)) {
    styles.push(match[0].replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, ''))
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const markup = bodyMatch[1].replace(STYLE_TAG_PATTERN, '').replace(SCRIPT_TAG_PATTERN, '').trim()
  return {
    title: titleMatch ? titleMatch[1].trim() : null,
    css: styles.join('\n'),
    markup,
  }
}

// --- Markdown (subset) ---------------------------------------------------------------

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

// Minimal renderer for the bundle's own docs (component.md, principles.md):
// #–### headings, `- ` bullets with indented continuations, paragraphs,
// inline `code` and **bold**. Anything else passes through as escaped text.
function renderMarkdown(md, baseLevel) {
  const out = []
  let listItems = null
  let paragraph = []
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (listItems !== null) {
      out.push(`<ul>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`)
      listItems = null
    }
  }
  for (const line of md.split(/\r?\n/)) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(baseLevel + heading[1].length - 2, 6)
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }
    const bullet = /^-\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      if (listItems === null) listItems = []
      listItems.push(bullet[1])
      continue
    }
    if (/^\s+\S/.test(line) && listItems !== null) {
      listItems[listItems.length - 1] += ` ${line.trim()}`
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return out.join('\n')
}

// Split a doc into its leading `# Title` and the rendered rest.
function renderDocument(md, fallbackTitle, baseLevel) {
  const titleMatch = /^#\s+(.+)$/m.exec(md)
  const body = titleMatch ? md.replace(titleMatch[0], '') : md
  return {
    title: titleMatch ? titleMatch[1].trim() : fallbackTitle,
    html: renderMarkdown(body, baseLevel),
  }
}

// --- Section builders ----------------------------------------------------------------

function chipMarkup(token) {
  const variable = cssVariableName(token.path)
  if (tokenIsModeVarying(token)) {
    return (
      `<span class="catalog-chip-pair">` +
      `<span class="catalog-chip" data-mode="light" style="background: var(${variable})" title="light"></span>` +
      `<span class="catalog-chip" data-mode="dark" style="background: var(${variable})" title="dark"></span>` +
      `</span>`
    )
  }
  return (
    `<span class="catalog-chip-pair">` +
    `<span class="catalog-chip" style="background: var(${variable})"></span>` +
    `</span>`
  )
}

function tokenMeta(token) {
  const vendor = tokenVendor(token)
  const parts = []
  if (typeof token.node.$description === 'string' && token.node.$description !== '') {
    parts.push(escapeHtml(token.node.$description))
  }
  if (vendor && typeof vendor.use === 'string' && vendor.use !== '') {
    parts.push(escapeHtml(vendor.use))
  }
  if (vendor && typeof vendor.doNotUse === 'string' && vendor.doNotUse !== '') {
    parts.push(`<strong>Do not:</strong> ${escapeHtml(vendor.doNotUse)}`)
  }
  return parts.join(' ')
}

function tokenBadges(token) {
  const vendor = tokenVendor(token)
  const badges = []
  if (vendor && typeof vendor.role === 'string' && vendor.role !== '') {
    badges.push(`<span class="catalog-badge">${escapeHtml(vendor.role)}</span>`)
  }
  if (vendor && typeof vendor.deprecated === 'object' && vendor.deprecated !== null) {
    const reason =
      typeof vendor.deprecated.reason === 'string' ? ` title="${escapeHtml(vendor.deprecated.reason)}"` : ''
    badges.push(`<span class="catalog-badge catalog-badge--deprecated"${reason}>deprecated</span>`)
  }
  return badges.join('')
}

function tokenRow(token, specimen) {
  return (
    `<div class="catalog-token-row">` +
    specimen +
    `<div class="catalog-token-text">` +
    `<p class="catalog-token-name"><code>${escapeHtml(token.path)}</code>` +
    `<code class="catalog-token-value">${escapeHtml(displayValue(token.node.$value))}</code>` +
    `${tokenBadges(token)}</p>` +
    `<p class="catalog-token-meta">${tokenMeta(token)}</p>` +
    `</div></div>`
  )
}

function paletteSection(tokens) {
  const colors = tokens.filter((token) => token.node.$type === 'color')
  if (colors.length === 0) return `<p class="catalog-empty">This system defines no color tokens.</p>`
  const tiers = new Map()
  for (const token of colors) {
    const tier = token.path.split('.')[0]
    if (!tiers.has(tier)) tiers.set(tier, [])
    tiers.get(tier).push(token)
  }
  let html = ''
  for (const [tier, tierTokens] of tiers) {
    html += `<h4 class="catalog-tier-heading"><code>${escapeHtml(tier)}</code> colors</h4>`
    html += tierTokens.map((token) => tokenRow(token, chipMarkup(token))).join('\n')
  }
  return html
}

function typeSection(tokens) {
  const type = tokens.filter((token) => token.node.$type !== 'color' && token.path.split('.').includes('font'))
  if (type.length === 0) return `<p class="catalog-empty">This system defines no type tokens.</p>`
  return type
    .map((token) => {
      const variable = cssVariableName(token.path)
      let specimen
      if (token.node.$type === 'fontFamily') {
        specimen = `<span class="catalog-type-specimen" style="font-family: var(${variable})">AaBb</span>`
      } else if (token.node.$type === 'fontWeight') {
        specimen = `<span class="catalog-type-specimen" style="font-weight: var(${variable})">AaBb</span>`
      } else {
        specimen = `<span class="catalog-type-specimen" style="font-size: var(${variable})">AaBb</span>`
      }
      return tokenRow(token, specimen)
    })
    .join('\n')
}

function spacingSection(tokens) {
  const space = tokens.filter((token) => token.node.$type === 'dimension' && token.path.split('.').includes('space'))
  if (space.length === 0) return `<p class="catalog-empty">This system defines no spacing tokens.</p>`
  return space
    .map((token) =>
      tokenRow(token, `<span class="catalog-space-bar" style="width: var(${cssVariableName(token.path)})"></span>`),
    )
    .join('\n')
}

function otherTokenRows(tokens) {
  const covered = (token) =>
    token.node.$type === 'color' ||
    token.path.split('.').includes('font') ||
    (token.node.$type === 'dimension' && token.path.split('.').includes('space'))
  const rest = tokens.filter((token) => !covered(token))
  if (rest.length === 0) return ''
  return rest
    .map((token) => {
      const specimen = token.path.split('.').includes('radius')
        ? `<span class="catalog-radius-box" style="border-radius: var(${cssVariableName(token.path)})"></span>`
        : `<span class="catalog-specimen-blank"></span>`
      return tokenRow(token, specimen)
    })
    .join('\n')
}

function glyphSection(glyphs) {
  if (glyphs.length === 0) {
    return `<p class="catalog-empty">This system defines no glyphs yet. Add <code>glyphs/&lt;concept&gt;.svg</code> and re-run <code>node scripts/build-catalog.mjs</code>.</p>`
  }
  const cells = glyphs
    .map(
      (glyph) =>
        `<figure class="catalog-glyph">${glyph.svg}<figcaption>${escapeHtml(glyph.name)}</figcaption></figure>`,
    )
    .join('\n')
  return `<div class="catalog-glyph-grid">\n${cells}\n</div>`
}

function sourceDetails(label, source) {
  return (
    `<details class="catalog-source"><summary>${escapeHtml(label)}</summary>` +
    `<pre><code>${escapeHtml(source)}</code></pre></details>`
  )
}

// --- Main ------------------------------------------------------------------------

function main() {
  const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const bundleRoot = resolve(rootArg ?? join(scriptDir, '..'))

  const manifestPath = join(bundleRoot, 'design-system.json')
  if (!existsSync(manifestPath)) {
    fail(`Not a design-system bundle (no design-system.json): ${bundleRoot}`, 2)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`design-system.json is not valid JSON: ${error.message}`, 2)
  }
  const contents = typeof manifest.contents === 'object' && manifest.contents !== null ? manifest.contents : {}

  const tokensCssPath = join(bundleRoot, 'foundations', 'tokens.css')
  if (!existsSync(tokensCssPath)) {
    fail('Missing foundations/tokens.css — run `node scripts/build-tokens.mjs` first; the catalog inlines it.', 2)
  }
  const tokensCss = readFileSync(tokensCssPath, 'utf8')

  const tokensJsonPath = join(bundleRoot, 'foundations', 'tokens.tokens.json')
  if (!existsSync(tokensJsonPath)) {
    fail(`Missing foundations/tokens.tokens.json in bundle: ${bundleRoot}`, 2)
  }
  let tokensDocument
  try {
    tokensDocument = JSON.parse(readFileSync(tokensJsonPath, 'utf8'))
  } catch (error) {
    fail(`foundations/tokens.tokens.json is not valid JSON: ${error.message}`, 2)
  }
  const tokens = collectTokens(tokensDocument, [], [])

  // Components: union of the registered set and what is on disk, so a freshly
  // added directory surfaces on the next regeneration even before its manifest
  // registration lands.
  const componentsDir = join(bundleRoot, 'components')
  const onDiskComponents = existsSync(componentsDir)
    ? readdirSync(componentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []
  const componentNames = [...new Set([...(contents.components ?? []), ...onDiskComponents])].sort()
  const components = componentNames.map((name) => {
    assertEmbedName(name, `components/${name}`)
    const dir = join(componentsDir, name)
    for (const file of ['component.html', 'component.css', 'component.md']) {
      if (!existsSync(join(dir, file))) {
        fail(
          `components/${name}: missing ${file} (a component directory carries component.html, component.css, and component.md)`,
        )
      }
    }
    const demo = extractEmbeddable(
      readFileSync(join(dir, 'component.html'), 'utf8'),
      `components/${name}/component.html`,
    )
    const doc = renderDocument(readFileSync(join(dir, 'component.md'), 'utf8'), name, 4)
    return {
      name,
      cssSource: readFileSync(join(dir, 'component.css'), 'utf8'),
      htmlSource: readFileSync(join(dir, 'component.html'), 'utf8'),
      demo,
      doc,
    }
  })

  const patternsDir = join(bundleRoot, 'patterns')
  const onDiskPatterns = existsSync(patternsDir)
    ? readdirSync(patternsDir)
        .filter((name) => name.endsWith('.html'))
        .map((name) => `patterns/${name}`)
    : []
  const patternPaths = [...new Set([...(contents.patterns ?? []), ...onDiskPatterns])].sort()
  const patterns = patternPaths.map((path) => {
    const filePath = join(bundleRoot, path)
    if (!existsSync(filePath)) fail(`${path}: registered in contents.patterns but missing on disk`)
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.html$/, '')
    assertEmbedName(stem, path)
    const source = readFileSync(filePath, 'utf8')
    const embed = extractEmbeddable(source, path)
    return { path, stem, source, embed }
  })

  const glyphsDir = join(bundleRoot, 'glyphs')
  const onDiskGlyphs = existsSync(glyphsDir)
    ? readdirSync(glyphsDir)
        .filter((name) => name.endsWith('.svg'))
        .map((name) => `glyphs/${name}`)
    : []
  const glyphPaths = [...new Set([...(contents.glyphs ?? []), ...onDiskGlyphs])].sort()
  const glyphs = glyphPaths.map((path) => {
    const filePath = join(bundleRoot, path)
    if (!existsSync(filePath)) fail(`${path}: registered in contents.glyphs but missing on disk`)
    return {
      name: path.slice(path.lastIndexOf('/') + 1).replace(/\.svg$/, ''),
      svg: readFileSync(filePath, 'utf8')
        .replace(/<\?xml[\s\S]*?\?>/, '')
        .trim(),
    }
  })

  const foundationDocs = (contents.foundations ?? [])
    .filter((path) => path.endsWith('.md'))
    .map((path) => {
      const filePath = join(bundleRoot, path)
      if (!existsSync(filePath)) fail(`${path}: registered in contents.foundations but missing on disk`)
      const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
      return { stem, ...renderDocument(readFileSync(filePath, 'utf8'), stem, 4) }
    })

  // --- Mode-toggle patch: re-declare the dark overrides under the checkbox ----
  const parsedTokensCss = parseTokensCss(tokensCss)
  // parseTokensCss depends on the pinned tokens.css emission format; if that
  // format ever drifts, the parse quietly yields nothing and the mode toggle
  // would ship as a silent no-op. The tokens document knows whether dark
  // overrides must exist — cross-check it and fail loudly instead.
  if (parsedTokensCss.dark.length === 0 && tokens.some(tokenIsModeVarying)) {
    fail(
      'foundations/tokens.css: tokens.tokens.json declares mode-varying tokens but no [data-mode="dark"] overrides were parsed — the tokens.css emission format has drifted from the pinned contract; regenerate it with node scripts/build-tokens.mjs and keep parseTokensCss in scripts/build-catalog.mjs in sync',
    )
  }
  const lightValues = new Map(parsedTokensCss.light.map((decl) => [decl.name, decl.value]))
  for (const decl of parsedTokensCss.dark) {
    if (!lightValues.has(decl.name)) {
      fail(
        `foundations/tokens.css: dark override ${decl.name} has no :root declaration — regenerate it with node scripts/build-tokens.mjs`,
      )
    }
  }
  let modePatchCss = ''
  if (parsedTokensCss.dark.length > 0) {
    modePatchCss +=
      `#ds-mode-dark:checked ~ .ds-catalog {\n` +
      parsedTokensCss.dark.map((decl) => `  ${decl.name}: ${decl.value};`).join('\n') +
      `\n}\n`
    // Demo islands pinned to light keep their light values under the toggle.
    modePatchCss +=
      `#ds-mode-dark:checked ~ .ds-catalog [data-mode="light"] {\n` +
      parsedTokensCss.dark.map((decl) => `  ${decl.name}: ${lightValues.get(decl.name)};`).join('\n') +
      `\n}\n`
  }

  // --- Assemble ------------------------------------------------------------------
  const systemName = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : 'design system'
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  const summary = typeof manifest.summary === 'string' ? manifest.summary : ''

  // Nav model: three groups, each with a header view (the whole group) and one
  // view per item. Every nav entry is a label for a hidden radio; fragment
  // links are unusable here (see the header comment).
  const foundationItems = [
    { id: 'foundations-palette', label: 'Palette', body: paletteSection(tokens) },
    { id: 'foundations-type', label: 'Type', body: typeSection(tokens) },
    { id: 'foundations-spacing', label: 'Spacing', body: spacingSection(tokens) },
    ...(otherTokenRows(tokens) === ''
      ? []
      : [{ id: 'foundations-other-tokens', label: 'Other tokens', body: otherTokenRows(tokens) }]),
    { id: 'foundations-glyphs', label: 'Glyphs', body: glyphSection(glyphs) },
    ...foundationDocs.map((doc) => ({
      id: `foundations-doc-${doc.stem}`,
      label: doc.title,
      body: doc.html,
      viewClass: ' catalog-doc-card',
    })),
  ]
  const componentItems = components.map((component) => ({
    id: `component-${component.name}`,
    label: component.doc.title,
    viewClass: ' catalog-component',
    body:
      `<div class="catalog-component-grid">\n` +
      `<div class="catalog-stage ds-embed-component-${component.name}">\n${component.demo.markup}\n</div>\n` +
      `<div class="catalog-doc">\n${component.doc.html}\n</div>\n` +
      `</div>\n` +
      sourceDetails(`components/${component.name}/component.css`, component.cssSource) +
      `\n` +
      sourceDetails(`components/${component.name}/component.html (demo)`, component.htmlSource),
  }))
  const patternItems = patterns.map((pattern) => ({
    id: `pattern-${pattern.stem}`,
    label: pattern.embed.title ?? pattern.stem,
    viewClass: ' catalog-pattern',
    body:
      `<div class="catalog-stage ds-embed-pattern-${pattern.stem}">\n${pattern.embed.markup}\n</div>\n` +
      sourceDetails(pattern.path, pattern.source),
  }))
  const groups = [
    {
      id: 'foundations',
      title: 'Foundations',
      items: foundationItems,
      empty: null,
    },
    {
      id: 'components',
      title: 'Components',
      items: componentItems,
      empty:
        'No components yet. Add <code>components/&lt;name&gt;/</code> (component.html, component.css, component.md) and re-run <code>node scripts/build-catalog.mjs</code>.',
    },
    {
      id: 'patterns',
      title: 'Patterns',
      items: patternItems,
      empty:
        'No patterns yet. Add <code>patterns/&lt;name&gt;.html</code> and re-run <code>node scripts/build-catalog.mjs</code>.',
    },
  ]
  const radioFor = (viewId) => `ds-view-${viewId}`

  const viewRadios = groups
    .flatMap((group) => [
      `<input type="radio" name="ds-view" class="ds-view-switch" id="${radioFor(group.id)}"${group.id === 'foundations' ? ' checked' : ''} />`,
      ...group.items.map(
        (item) => `<input type="radio" name="ds-view" class="ds-view-switch" id="${radioFor(item.id)}" />`,
      ),
    ])
    .join('\n')

  const navMarkup = groups
    .map((group) => {
      const header = `<label class="catalog-nav-group" for="${radioFor(group.id)}">${escapeHtml(group.title)}</label>`
      if (group.items.length === 0) {
        return `${header}\n<span class="catalog-nav-empty">none yet</span>`
      }
      const items = group.items
        .map((item) => `<label class="catalog-nav-item" for="${radioFor(item.id)}">${escapeHtml(item.label)}</label>`)
        .join('\n')
      return `${header}\n${items}`
    })
    .join('\n')

  const mainMarkup = groups
    .map((group) => {
      const views =
        group.items.length > 0
          ? group.items
              .map(
                (item) =>
                  `<div id="${item.id}" class="catalog-view${item.viewClass ?? ''}">\n<h3>${escapeHtml(item.label)}</h3>\n${item.body}\n</div>`,
              )
              .join('\n')
          : `<p class="catalog-view catalog-empty">${group.empty}</p>`
      return `<section id="${group.id}" class="catalog-group">\n<h2>${escapeHtml(group.title)}</h2>\n${views}\n</section>`
    })
    .join('\n')

  // Per-view visibility, nav highlight, and keyboard focus rules. The header
  // radio shows its whole group; an item radio shows the group shell plus that
  // one view.
  const navRules = []
  for (const group of groups) {
    const headerRadio = radioFor(group.id)
    navRules.push(
      `#${headerRadio}:checked ~ .ds-catalog #${group.id} { display: block; }`,
      `#${headerRadio}:checked ~ .ds-catalog #${group.id} .catalog-view { display: block; }`,
    )
    for (const item of group.items) {
      const radio = radioFor(item.id)
      navRules.push(
        `#${radio}:checked ~ .ds-catalog #${group.id} { display: block; }`,
        `#${radio}:checked ~ .ds-catalog #${item.id} { display: block; }`,
      )
    }
    for (const radio of [headerRadio, ...group.items.map((item) => radioFor(item.id))]) {
      // The selected item must not rely on color alone: pair the accent with a
      // weight shift and a currentColor inset bar so it survives grayscale.
      navRules.push(
        `#${radio}:checked ~ .ds-catalog .catalog-nav label[for="${radio}"] { color: var(--sem-color-accent-primary, #2f6a4a); font-weight: var(--sem-font-weight-emphasis, 600); box-shadow: inset 2px 0 0 currentColor; }`,
        `#${radio}:focus-visible ~ .ds-catalog .catalog-nav label[for="${radio}"] { outline: 2px solid var(--sem-color-accent-hover, #275842); outline-offset: 2px; }`,
      )
    }
  }
  const navCss = navRules.join('\n')

  const componentCssBlocks = components
    .map((component) => `/* components/${component.name}/component.css */\n${component.cssSource}`)
    .join('\n')
  const scopedDemoCss = [
    ...components.map((component) =>
      component.demo.css.trim() === '' ? '' : scopeCss(component.demo.css, `.ds-embed-component-${component.name}`),
    ),
    ...patterns.map((pattern) =>
      pattern.embed.css.trim() === '' ? '' : scopeCss(pattern.embed.css, `.ds-embed-pattern-${pattern.stem}`),
    ),
  ]
    .filter((css) => css !== '')
    .join('\n')

  const chromeCss = `/* Catalog chrome — consumes the bundle's own semantic tokens. */
body { margin: 0; }
.ds-catalog {
  min-height: 100vh;
  background: var(--sem-color-bg-app, #ffffff);
  color: var(--sem-color-text-primary, #17170f);
  font-family: var(--sem-font-family-ui, system-ui, sans-serif);
  font-size: var(--sem-font-size-body, 14px);
  line-height: 1.5;
}
#ds-mode-dark, .ds-view-switch {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.catalog-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding: 20px 28px 16px;
  border-bottom: 1px solid var(--sem-color-border-default, #dddddd);
}
.catalog-header h1 { margin: 0; font-size: 20px; }
.catalog-header .catalog-version { color: var(--sem-color-text-muted, #666666); }
.catalog-header .catalog-summary { flex-basis: 100%; margin: 2px 0 0; color: var(--sem-color-text-muted, #666666); }
.catalog-mode-toggle {
  margin-left: auto;
  padding: 4px 12px;
  border: 1px solid var(--sem-color-border-default, #dddddd);
  border-radius: var(--sem-radius-control, 5px);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.catalog-mode-when-dark { display: none; }
#ds-mode-dark:checked ~ .ds-catalog .catalog-mode-when-light { display: none; }
#ds-mode-dark:checked ~ .ds-catalog .catalog-mode-when-dark { display: inline; }
#ds-mode-dark:focus-visible ~ .ds-catalog .catalog-mode-toggle {
  outline: 2px solid var(--sem-color-accent-hover, #275842);
  outline-offset: 2px;
}
.catalog-layout { display: flex; align-items: flex-start; }
.catalog-nav {
  position: sticky;
  top: 0;
  flex: 0 0 200px;
  max-height: 100vh;
  overflow-y: auto;
  padding: 20px 20px 28px 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* Left padding is the gutter for the selected item's inset bar. */
.catalog-nav-item {
  color: var(--sem-color-text-primary, #17170f);
  padding: 2px 0 2px 8px;
  cursor: pointer;
}
.catalog-nav-item:hover { color: var(--sem-color-accent-primary, #2f6a4a); }
.catalog-nav-group {
  margin: 14px 0 4px;
  padding-left: 8px;
  font-weight: var(--sem-font-weight-emphasis, 600);
  color: var(--sem-color-text-muted, #666666);
  cursor: pointer;
}
.catalog-nav-group:hover { color: var(--sem-color-text-primary, #17170f); }
.catalog-nav-group:first-child { margin-top: 0; }
.catalog-nav-empty { color: var(--sem-color-text-muted, #666666); }
.catalog-main { flex: 1; min-width: 0; padding: 24px 28px 64px; }
/* Views are radio-driven: everything is hidden until its nav radio shows it. */
.catalog-group { display: none; }
.catalog-view { display: none; margin: 0 0 36px; }
/* Structural headings only — child combinators keep embedded demo markup untouched. */
.catalog-main > section > h2 {
  margin: 0 0 16px;
  padding-bottom: 8px;
  font-size: 17px;
  border-bottom: 1px solid var(--sem-color-border-default, #dddddd);
}
.catalog-view > h3 { margin: 0 0 10px; font-size: 15px; }
.catalog-tier-heading { margin: 18px 0 8px; }
.catalog-empty { color: var(--sem-color-text-muted, #666666); }
.catalog-token-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 0;
  border-bottom: 1px solid var(--sem-color-border-default, #dddddd);
}
.catalog-token-text { min-width: 0; }
.catalog-token-name { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.catalog-token-value { color: var(--sem-color-text-muted, #666666); }
.catalog-token-meta { margin: 2px 0 0; font-size: 0.92em; color: var(--sem-color-text-muted, #666666); }
.catalog-badge {
  padding: 1px 7px;
  border: 1px solid var(--sem-color-border-default, #dddddd);
  border-radius: 999px;
  font-size: 0.85em;
  color: var(--sem-color-text-muted, #666666);
}
.catalog-badge--deprecated {
  color: var(--sem-color-status-danger, #b8433a);
  border-color: var(--sem-color-status-danger, #b8433a);
}
.catalog-chip-pair { display: inline-flex; flex: none; }
/* Mode-stable hairline: chip fills can equal border.default or the page
   background in either mode, so the swatch edge must not ride the tokens
   it is displaying. */
.catalog-chip {
  width: 34px;
  height: 26px;
  border: 1px solid rgba(127, 127, 127, 0.55);
}
.catalog-chip-pair .catalog-chip + .catalog-chip { border-left: 0; }
.catalog-type-specimen { flex: none; width: 72px; text-align: center; }
.catalog-space-bar {
  flex: none;
  height: 12px;
  background: var(--sem-color-accent-primary, #2f6a4a);
}
.catalog-radius-box {
  flex: none;
  width: 34px;
  height: 26px;
  border: 1px solid var(--sem-color-text-muted, #666666);
}
.catalog-specimen-blank { flex: none; width: 34px; }
.catalog-glyph-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.catalog-glyph {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 84px;
  padding: 12px 6px 8px;
  border: 1px solid var(--sem-color-border-default, #dddddd);
  border-radius: var(--sem-radius-overlay, 7px);
}
.catalog-glyph svg { width: 20px; height: 20px; }
.catalog-glyph figcaption { font-size: 0.85em; color: var(--sem-color-text-muted, #666666); }
.catalog-component-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 18px;
  align-items: start;
}
@media (max-width: 900px) { .catalog-component-grid { grid-template-columns: 1fr; } }
.catalog-stage {
  border: 1px solid var(--sem-color-border-default, #dddddd);
  border-radius: var(--sem-radius-overlay, 7px);
  overflow: hidden;
  /* Embedded demos are source-faithful and may not wrap; let narrow panes
     scroll to overflowing specimens instead of clipping them. */
  overflow-x: auto;
}
.catalog-doc h4 { margin: 14px 0 6px; font-size: 13px; }
.catalog-doc h4:first-child { margin-top: 0; }
.catalog-doc p, .catalog-doc ul { margin: 0 0 8px; }
.catalog-doc ul { padding-left: 18px; }
.catalog-doc-card { max-width: 720px; }
.catalog-doc-card h4 { margin: 16px 0 6px; }
.catalog-doc-card ul { padding-left: 18px; }
.catalog-source { margin-top: 10px; }
.catalog-source summary { cursor: pointer; color: var(--sem-color-text-muted, #666666); }
.catalog-source pre {
  margin: 8px 0 0;
  padding: 12px;
  overflow-x: auto;
  border: 1px solid var(--sem-color-border-default, #dddddd);
  border-radius: var(--sem-radius-control, 5px);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  line-height: 1.45;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.95em;
}
/* Narrow-pane layout: the catalog's primary home is the studio preview pane,
   a narrow column. Stack the layout and let token rows wrap. */
@media (max-width: 640px) {
  .catalog-layout { flex-direction: column; }
  .catalog-nav {
    position: static;
    flex: none;
    max-height: none;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 14px;
    padding: 14px 20px 10px;
    border-bottom: 1px solid var(--sem-color-border-default, #dddddd);
  }
  .catalog-nav .catalog-nav-group { margin: 0; }
  .catalog-main { padding: 20px 20px 48px; }
  .catalog-token-row { flex-wrap: wrap; }
}`

  const html = `<!doctype html>
<!-- GENERATED FILE — do not edit by hand.
     Derived from this bundle's manifest, tokens, components, patterns, and
     glyphs by scripts/build-catalog.mjs. Regenerate with:
       node scripts/build-catalog.mjs -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(systemName)} — design system catalog</title>
<style>
/* foundations/tokens.css (inlined verbatim) */
${tokensCss}</style>
<style>
/* CSS-only mode toggle: the hidden checkbox re-declares the dark overrides. */
${modePatchCss}</style>
<style>
${chromeCss}
</style>
<style>
/* CSS-only nav: each rule shows the view selected by its hidden radio. */
${navCss}
</style>
<style>
${componentCssBlocks}
</style>
<style>
/* Demo and pattern scaffolding, scoped to each embed wrapper. */
${scopedDemoCss}
</style>
</head>
<body>
<input type="checkbox" id="ds-mode-dark" />
${viewRadios}
<div class="ds-catalog">
<header class="catalog-header">
<h1>${escapeHtml(systemName)}</h1>
${version === '' ? '' : `<span class="catalog-version">v${escapeHtml(version)}</span>\n`}<label class="catalog-mode-toggle" for="ds-mode-dark"><span class="catalog-mode-when-light">Light mode — switch to dark</span><span class="catalog-mode-when-dark">Dark mode — switch to light</span></label>
${summary === '' ? '' : `<p class="catalog-summary">${escapeHtml(summary)}</p>\n`}</header>
<div class="catalog-layout">
<nav class="catalog-nav" aria-label="Catalog">
${navMarkup}
</nav>
<main class="catalog-main">
${mainMarkup}
</main>
</div>
</div>
</body>
</html>
`

  mkdirSync(join(bundleRoot, 'catalog'), { recursive: true })
  writeFileSync(join(bundleRoot, 'catalog', 'index.html'), html)
  return `wrote catalog/index.html (${components.length} components, ${patterns.length} patterns, ${glyphs.length} glyphs)\n`
}

try {
  process.stdout.write(main())
  exitAfterFlush(0)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  exitAfterFlush(error instanceof BuildFailure ? error.code : 1)
}
