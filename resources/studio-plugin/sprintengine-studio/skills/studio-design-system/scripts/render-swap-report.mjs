#!/usr/bin/env node
// Render a design-system before/after page from swept sites and real React.
//
// The page is an ARTIFACT-READY FRAGMENT: a <title>, three <style> blocks and a
// <main>, with no <!doctype>, <html>, <head> or <body> of its own — which is
// exactly what the Artifact tool wraps. Nothing on it is a code block. The
// specimens ARE the content: each one is markup React rendered from the real
// primitives, painted by the application's own compiled stylesheet.
//
// Four things it does that a screenshot cannot:
//
//   1. BEFORE is the raw JSX as it stood, AFTER is the kit call as it stands.
//      Both come out of one specimen module, so the two are rendered by the
//      same React on the same day and differ only where the swap differs.
//   2. Both of the app's grounds appear on every page, whatever theme the
//      reader is in. The app picks a theme with `data-theme` + `data-mode` on
//      <html> (see the head comment of src/renderer/src/assets/index.css), so a
//      wrapper element carrying those attributes selects NOTHING — the token
//      blocks have to be re-declared on `.gnd-light` / `.gnd-dark` classes.
//      That is what buildGrounds() below does, out of the two real sources.
//   3. Hover, focus and pressed are restated on wrapper classes, because a page
//      that is only read never enters those states.
//   4. Every site is counted, and the full list is one collapsible table in the
//      footer — the only place a file path appears.
//
// Usage:
//   node render-swap-report.mjs --out <file.html> \
//     --sites <sites.json> [--sites <more.json> …] \
//     --css <built-stylesheet.css> --tokens <tokens.css> [--tokens <more.css> …] \
//     [--specimens <specimens.tsx>] [--alias name=dir] [--repo <root>] \
//     [--title "…"] [--lede "…"] [--sha <short sha>]
//
// --css is the PROJECT'S OWN built stylesheet — whatever its build emits, named
// explicitly; nothing here guesses an output layout. It is what makes the
// specimens the real thing rather than a sketch, so build before rendering.
// --tokens names each stylesheet whose :root blocks carry the custom properties
// the specimens consume, in cascade order: the bundle's derived
// foundations/tokens.css first, then any app layer that aliases it. In each
// file, a rule list containing a bare :root feeds BOTH grounds, one qualified
// only by "dark" feeds the dark ground, one qualified only by "light" the
// light ground. Values are never restated here: a copy is the drift the design
// system exists to end.
// --repo is the project root: where node_modules (esbuild, react, react-dom)
// resolve from, where the specimen bundle is built, and the prefix trimmed off
// site paths. --alias repeats, one per import prefix the specimen module uses
// (e.g. --alias @renderer=src/renderer/src).
//
// --specimens names a module exporting `SPECIMENS: Record<string, ReactNode>`.
// Without it the page is the masthead, the counts and the table: useful for a
// sweep that has not drawn anything yet, and never a substitute for proof.
//
// A site record is the sweep's own JSON row:
//   { file, line, element, status, before, after, kit, note, lane?, kitMember? }
// `status` is "swapped" | "kept" | "needs-variant". A row that also carries a
// `specimen` object gets drawn:
//   specimen: { id, ground, name, eyebrow?, states?, wrap?, near?, want? }
// Specimen ids follow one convention, and the module must export them:
//   swapped       <id>-before-<state> and <id>-after-<state>, "rest" required
//   kept          <id>-raw, shown once as it stands under the reason it was kept
//   needs-variant <id>-raw and <id>-forced
// Two optional fields shape the page rather than the counts: `lane` is the pass
// of the sweep the row came from, and the masthead counts each lane beside the
// statuses; `kitMember` is the component that draws the site now, and the
// swapped bands are grouped under it. A sweep that names neither loses nothing.
// `ground` is a token name the specimen sits on in the app (--bg-canvas,
// --bg-app, --bg-surface). `wrap` is "plain" (default), "popover" or "card".

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// ── arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    sites: [],
    tokens: [],
    alias: {},
    repo: process.cwd(),
    title: 'Design system: before and after',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => {
      const value = argv[(i += 1)]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--sites') opts.sites.push(take())
    else if (arg === '--tokens') opts.tokens.push(take())
    else if (arg === '--css') opts.css = take()
    else if (arg === '--alias') {
      const spec = take()
      const eq = spec.indexOf('=')
      if (eq <= 0) throw new Error(`--alias wants name=dir, got ${spec}`)
      opts.alias[spec.slice(0, eq)] = spec.slice(eq + 1)
    } else if (arg === '--repo') opts.repo = path.resolve(take())
    else if (arg === '--out') opts.out = path.resolve(take())
    else if (arg === '--specimens') opts.specimens = path.resolve(take())
    else if (arg === '--title') opts.title = take()
    else if (arg === '--lede') opts.lede = take()
    else if (arg === '--sha') opts.sha = take()
    else throw new Error(`unknown flag ${arg}`)
  }
  if (opts.sites.length === 0) throw new Error('at least one --sites <file.json> is required')
  if (!opts.out) throw new Error('--out <file.html> is required')
  if (!opts.css) throw new Error('--css <built-stylesheet.css> is required')
  if (opts.tokens.length === 0) throw new Error('at least one --tokens <tokens.css> is required')
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const REPO = opts.repo
const cacheDir = path.join(REPO, 'node_modules', '.cache', 'sprintengine')

// ── the project's built stylesheet ───────────────────────────────────────────
// Named, never guessed: --css points at whatever the project's build emits.
function resolveAppCss() {
  return path.resolve(REPO, opts.css)
}

// ── the two grounds ──────────────────────────────────────────────────────────
// The app's light and dark token blocks, re-declared on two classes. Read from
// the bundle and from the app's alias layer, never restated: a value copied
// here would be the nineteen-theme drift the design system exists to end.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every top-level rule, in source order, as { selector, body }. */
function eachRule(css) {
  const rules = []
  let i = 0
  for (;;) {
    const open = css.indexOf('{', i)
    if (open < 0) return rules
    const selector = css.slice(i, open).trim().split(/\s+/).join(' ')
    let depth = 1
    let k = open + 1
    while (depth > 0 && k < css.length) {
      if (css[k] === '{') depth += 1
      else if (css[k] === '}') depth -= 1
      k += 1
    }
    rules.push({ selector, body: css.slice(open + 1, k - 1) })
    i = k
  }
}

/**
 * Which ground(s) a rule's custom properties belong to.
 *
 * A selector list carrying a bare `:root` (or any selector qualified by
 * neither word) is the base tier and feeds BOTH grounds; one qualified only by
 * "dark" feeds dark; one qualified only by "light" feeds light. That is enough
 * to read a bundle's tokens.css (`:root` light tier, `[data-mode="dark"]`) and
 * an app alias layer that inverts the default (`:root, :root[data-theme="dark"]`
 * plus `:root[data-theme="light"]`) with one rule and no per-project casing.
 *
 * A rule qualified by an attribute value that is NEITHER light nor dark is a
 * MODE the report is not in - a named palette, a window material, a density -
 * and declares neither ground, so it is skipped. Left in, it reads as a base
 * tier: its literals land in BOTH grounds and the last such block in the file
 * paints every specimen, which is how a light ground comes out dark.
 */
function grounding(selector) {
  const parts = selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) =>
      [...part.matchAll(/\[[a-zA-Z-]+(?:=)?"?([^\]"]*)"?\]/g)].every(
        (m) => m[1] === '' || m[1] === 'light' || m[1] === 'dark',
      ),
    )
  if (parts.length === 0) return 'skip'
  if (parts.some((part) => !/\b(dark|light)\b/.test(part))) return 'both'
  const dark = parts.some((part) => /\bdark\b/.test(part))
  const light = parts.some((part) => /\blight\b/.test(part))
  return dark && light ? 'both' : dark ? 'dark' : 'light'
}

/** Top-level custom-property declarations only — nested rules are dropped. */
function customProps(body) {
  const out = []
  let depth = 0
  let buf = ''
  for (const ch of body) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ';' && depth === 0) {
      if (buf.trim().startsWith('--')) out.push(`${buf.trim()};`)
      buf = ''
    } else buf += ch
  }
  if (buf.trim().startsWith('--')) out.push(`${buf.trim()};`)
  return out
}

function buildGrounds() {
  const light = []
  const dark = []
  for (const file of opts.tokens) {
    const css = stripComments(readFileSync(path.resolve(REPO, file), 'utf8'))
    for (const rule of eachRule(css)) {
      const props = customProps(rule.body)
      if (props.length === 0) continue
      const where = grounding(rule.selector)
      if (where === 'skip') continue
      if (where !== 'dark') light.push(...props)
      if (where !== 'light') dark.push(...props)
    }
  }
  return {
    css: `.gnd-light{\n${light.join('\n')}\n}\n.gnd-dark{\n${dark.join('\n')}\n}\n`,
    counts: { light: light.length, dark: dark.length },
  }
}

// ── the specimens ────────────────────────────────────────────────────────────
// esbuild as a CommonJS bundle for Node with the automatic JSX runtime, plus the
// @renderer alias the app's own imports need, then one node run that renders
// each node to static markup.
function renderSpecimens(modulePath) {
  const require = createRequire(path.join(REPO, 'package.json'))
  const esbuild = require('esbuild')
  mkdirSync(cacheDir, { recursive: true })
  const entry = path.join(cacheDir, 'swap-report-entry.tsx')
  const bundle = path.join(cacheDir, 'swap-report-specimens.cjs')
  const markup = path.join(cacheDir, 'swap-report-specimens.json')
  writeFileSync(
    entry,
    [
      `import { renderToStaticMarkup } from 'react-dom/server'`,
      `import { writeFileSync } from 'node:fs'`,
      `import { SPECIMENS } from ${JSON.stringify(modulePath)}`,
      `const out = {}`,
      `for (const [id, node] of Object.entries(SPECIMENS)) out[id] = renderToStaticMarkup(node)`,
      `writeFileSync(process.argv[2], JSON.stringify(out))`,
      `console.log('rendered ' + Object.keys(out).length + ' specimens')`,
      '',
    ].join('\n'),
  )
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    packages: 'bundle',
    external: ['react', 'react-dom', 'react-dom/server'],
    absWorkingDir: REPO,
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.jpg': 'dataurl' },
    alias: Object.fromEntries(Object.entries(opts.alias).map(([name, dir]) => [name, path.resolve(REPO, dir)])),
    logLevel: 'warning',
  })
  const run = spawnSync(process.execPath, [bundle, markup], { cwd: REPO, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`specimen render failed:\n${run.stderr || run.stdout}`)
  process.stdout.write(run.stdout)
  return JSON.parse(readFileSync(markup, 'utf8'))
}

// ── the sites ────────────────────────────────────────────────────────────────
const STATUSES = ['swapped', 'kept', 'needs-variant']
const rows = []
for (const file of opts.sites) {
  const parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${file}: a sites file is an array of records`)
  for (const record of parsed) {
    if (!record.file || typeof record.line !== 'number') throw new Error(`${file}: a record needs file and line`)
    if (!STATUSES.includes(record.status))
      throw new Error(`${file}: ${record.file}:${record.line} has status "${record.status}"`)
    rows.push({ ...record, file: String(record.file).replace(`${REPO}/`, '') })
  }
}
rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
const count = (status) => rows.filter((r) => r.status === status).length
const nSwap = count('swapped')
const nKept = count('kept')
const nWait = count('needs-variant')

/** The sweep's own lanes, in the order they were swept. Empty if none named. */
const laneCounts = []
for (const row of rows) {
  if (!row.lane) continue
  const found = laneCounts.find((l) => l.name === row.lane)
  if (found) found.n += 1
  else laneCounts.push({ name: row.lane, n: 1 })
}

const SPECS = opts.specimens ? renderSpecimens(opts.specimens) : {}
const missing = []
function spec(id) {
  if (SPECS[id] === undefined) {
    missing.push(id)
    return ''
  }
  return SPECS[id]
}

// ── markup helpers ───────────────────────────────────────────────────────────
const esc = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const WRAP = {
  plain: (m) => m,
  popover: (m) => `<div class="fakepop">${m}</div>`,
  card: (m) => `<div class="fakecard">${m}</div>`,
}

function tile(inner, mode, ground, caption, zoom = 1, state = null) {
  const cls = ['gnd-' + mode, 'spec', state ? `st-${state}` : '', zoom === 2 ? 'z2' : ''].filter(Boolean).join(' ')
  return (
    `<figure class="cell"><div class="swatch">` +
    `<div class="${cls}" style="--spec-ground:var(${ground})">${inner}</div></div>` +
    `<figcaption>${esc(caption)}</figcaption></figure>`
  )
}

/** Life size and double, on both grounds — the four views every specimen gets. */
function quad(inner, ground) {
  return [
    tile(inner, 'light', ground, 'Light'),
    tile(inner, 'dark', ground, 'Dark'),
    tile(inner, 'light', ground, 'Light 2x', 2),
    tile(inner, 'dark', ground, 'Dark 2x', 2),
  ].join('')
}

const STATE_CAPTION = { rest: 'Rest', hover: 'Hover', focus: 'Focus', press: 'Pressed', selected: 'Selected' }
const FORCED = { hover: 'hover', focus: 'focus', press: 'press' }

function stateStrip(id, states, ground, wrap) {
  const cols = states.map((state) => {
    const before = wrap(spec(`${id}-before-${state}`) || spec(`${id}-before-rest`))
    const after = wrap(spec(`${id}-after-${state}`) || spec(`${id}-after-rest`))
    const forced = FORCED[state] ? ` st-${FORCED[state]}` : ''
    const cell = (markup, letter) =>
      `<div class="staterow"><span class="ab">${letter}</span><div class="swatch">` +
      `<div class="gnd-dark spec z2${forced}" style="--spec-ground:var(${ground})">${markup}</div></div></div>`
    return (
      `<div class="statecol"><p class="statecap">${esc(STATE_CAPTION[state] ?? state)}</p>` +
      `<div class="statepair">${cell(before, 'A')}${cell(after, 'B')}</div></div>`
    )
  })
  return `<div class="states">${cols.join('')}</div>`
}

function band(record) {
  const s = record.specimen
  const wrap = WRAP[s.wrap ?? 'plain']
  const ground = s.ground ?? '--bg-app'
  const states = s.states ?? ['rest', 'hover', 'focus', 'press']
  const before = quad(wrap(spec(`${s.id}-before-rest`)), ground)
  const after = quad(wrap(spec(`${s.id}-after-rest`)), ground)
  return `<section class="band">
<div class="band-head"><div class="titles"><p class="eyebrow">${esc(s.eyebrow ?? path.basename(record.file))}</p>
<h3>${esc(s.name)}</h3></div><span class="kitchip">now ${esc(record.kit)}</span></div>
<div class="proof">
  <div class="side"><div class="sidehead"><span class="ab">A</span><h4>Before</h4></div><div class="cellrow">${before}</div></div>
  <div class="side is-after"><div class="sidehead"><span class="ab">B</span><h4>After</h4></div><div class="cellrow">${after}</div></div>
</div>
<div class="statewrap"><p class="eyebrow">States, on the dark ground - A before, B after</p>${stateStrip(s.id, states, ground, wrap)}</div>
<p class="note">${esc(record.note)}</p>
</section>`
}

function family(record) {
  const s = record.specimen
  const wrap = WRAP[s.wrap ?? 'plain']
  const ground = s.ground ?? '--bg-app'
  return `<section class="fam">
<div class="fam-head"><div class="titles"><p class="eyebrow">${esc(s.eyebrow ?? path.basename(record.file))}</p>
<h3>${esc(s.name)}</h3></div><span class="wants">waiting on ${esc(s.want ?? record.kit)}</span></div>
<div class="fampair">
  <div class="famcol"><p class="famhead">Raw, as it stands</p><div class="cellrow">${quad(wrap(spec(`${s.id}-raw`)), ground)}</div></div>
  <div class="famcol"><p class="famhead">Forced onto the nearest kit variant</p><div class="cellrow">${quad(wrap(spec(`${s.id}-forced`)), ground)}</div></div>
</div>
<p class="note"><span class="near">Nearest today: ${esc(s.near ?? record.kit)}.</span> ${esc(record.note)}</p>
</section>`
}

/** A control kept raw: shown once, as it stands, under the reason it was kept. */
function keptCard(record) {
  const s = record.specimen
  const wrap = WRAP[s.wrap ?? 'plain']
  const ground = s.ground ?? '--bg-app'
  return `<section class="fam">
<div class="fam-head"><div class="titles"><p class="eyebrow">${esc(s.eyebrow ?? path.basename(record.file))}</p>
<h3>${esc(s.name)}</h3></div><span class="wants">kept raw</span></div>
<div class="fampair">
  <div class="famcol"><p class="famhead">As it stands, unchanged</p><div class="cellrow">${quad(wrap(spec(`${s.id}-raw`)), ground)}</div></div>
</div>
<p class="note">${esc(record.note)}</p>
</section>`
}

const drawnSwaps = rows.filter((r) => r.status === 'swapped' && r.specimen)
const drawnKept = rows.filter((r) => r.status === 'kept' && r.specimen)
const nUndrawn = rows.filter((r) => r.status === 'kept' && !r.specimen).length
const drawnFamilies = rows.filter((r) => r.status === 'needs-variant' && r.specimen)

const table =
  `<table class="sites"><thead><tr><th>File</th><th class="c-line">Line</th><th>Tag</th>` +
  `<th class="c-stat">Status</th><th class="c-kit">Kit</th></tr></thead><tbody>` +
  rows
    .map(
      (r) =>
        `<tr class="r-${esc(r.status)}"><td class="c-file">${esc(r.file)}</td><td class="c-line">${r.line}</td>` +
        `<td>${esc(r.element ?? '')}</td><td class="c-stat">${esc(r.status)}</td><td class="c-kit">${esc(r.kit ?? '')}</td></tr>`,
    )
    .join('') +
  `</tbody></table>`

// ── page CSS ─────────────────────────────────────────────────────────────────
// The page's own chrome, which is NOT the app's: tokens on a bare :root, the
// same set redeclared under prefers-color-scheme and again under
// [data-theme="dark"] so an explicit toggle wins in both directions.
const PAGE_CSS = String.raw`
:root{
  --rp-page:#e0e4e8; --rp-sheet:#ffffff; --rp-sheet-2:#eaeef2;
  --rp-text:#202428; --rp-dim:#3c444c; --rp-mut:#646c78; --rp-faint:#808894;
  --rp-rule:#c8c8d0; --rp-rule-soft:#e0e4e8;
  --rp-accent:#2f6a4a; --rp-warn:#9a6000;
  --rp-check:rgba(32,36,40,.055);
  --rp-shadow:0 1px 2px rgba(8,8,12,.07), 0 8px 24px -12px rgba(8,8,12,.18);
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --rp-page:#08080c; --rp-sheet:#0c0c10; --rp-sheet-2:#101418;
  --rp-text:#ececec; --rp-dim:#c8c8d0; --rp-mut:#9c9ca4; --rp-faint:#707078;
  --rp-rule:#24242c; --rp-rule-soft:#18181c;
  --rp-accent:#4daf7d; --rp-warn:#fcc030;
  --rp-check:rgba(236,236,236,.05);
  --rp-shadow:0 1px 2px rgba(0,0,0,.5), 0 8px 24px -12px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  --rp-page:#08080c; --rp-sheet:#0c0c10; --rp-sheet-2:#101418;
  --rp-text:#ececec; --rp-dim:#c8c8d0; --rp-mut:#9c9ca4; --rp-faint:#707078;
  --rp-rule:#24242c; --rp-rule-soft:#18181c;
  --rp-accent:#4daf7d; --rp-warn:#fcc030;
  --rp-check:rgba(236,236,236,.05);
  --rp-shadow:0 1px 2px rgba(0,0,0,.5), 0 8px 24px -12px rgba(0,0,0,.7);
}
/* the app stylesheet above pins html/body to the window; this page scrolls */
html,body{height:auto!important;overflow:visible!important}
body{margin:0!important;padding:0!important;background:var(--rp-page)!important;color:var(--rp-text)!important;
  font-family:ui-sans-serif,system-ui,"Helvetica Neue",Arial,sans-serif!important;font-feature-settings:normal!important;
  -webkit-font-smoothing:antialiased;font-size:15px;line-height:1.55}
.rp{max-width:1180px;margin:0 auto;padding:40px 24px 72px}
.rp *{box-sizing:border-box}
.rp h1,.rp h2,.rp h3{font-weight:600;text-wrap:balance;margin:0;letter-spacing:-.012em}
.rp h1{font-size:clamp(28px,4.2vw,42px);line-height:1.04;font-weight:700;letter-spacing:-.026em}
.rp h2{font-size:22px;line-height:1.15}
.rp h3{font-size:18px;line-height:1.2}
.rp p{margin:0}
.eyebrow,figcaption,.statecap,.ab,.famhead,.sites,.kitchip,.stat-n,.foot,.wants,.near{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-feature-settings:"tnum"}
.eyebrow{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--rp-mut);margin:0 0 6px}
.masthead{display:grid;gap:24px;padding:0 0 30px;border-bottom:1px solid var(--rp-rule);margin-bottom:44px}
.sha{color:var(--rp-accent)}
.stand{max-width:66ch;color:var(--rp-dim);font-size:16px}
.stand + .stand{margin-top:12px}
.stats{display:flex;flex-wrap:wrap;border:1px solid var(--rp-rule);border-radius:2px;overflow:hidden;width:fit-content;background:var(--rp-sheet)}
.stat{padding:12px 22px 11px;border-right:1px solid var(--rp-rule);min-width:130px}
.stat:last-child{border-right:0}
.stat-n{display:block;font-size:26px;font-weight:500;line-height:1;letter-spacing:-.02em}
.stat-l{display:block;margin-top:5px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--rp-mut)}
.stat.is-wait .stat-n{color:var(--rp-warn)}
.stat.is-swap .stat-n{color:var(--rp-accent)}
.method{border-left:2px solid var(--rp-accent);padding-left:14px;max-width:70ch;font-size:13.5px;color:var(--rp-mut)}
.secthead{margin:56px 0 22px;padding-top:22px;border-top:1px solid var(--rp-rule)}
.secthead:first-of-type{border-top:0;padding-top:0}
.secthead p.lede{margin-top:9px;max-width:68ch;color:var(--rp-dim);font-size:14.5px}
.band,.fam{background:var(--rp-sheet);border:1px solid var(--rp-rule);border-radius:3px;box-shadow:var(--rp-shadow);margin-bottom:24px;overflow:hidden}
.band-head,.fam-head{padding:20px 24px 18px;border-bottom:1px solid var(--rp-rule-soft);display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-start}
.titles{flex:1 1 340px;min-width:0}
.kitchip{font-size:11px;color:var(--rp-accent);border:1px solid color-mix(in srgb,var(--rp-accent) 34%,transparent);
  border-radius:2px;padding:4px 8px;white-space:nowrap;align-self:center;background:color-mix(in srgb,var(--rp-accent) 7%,transparent)}
.wants{align-self:center;font-size:11px;color:var(--rp-warn);border:1px solid color-mix(in srgb,var(--rp-warn) 38%,transparent);
  border-radius:2px;padding:4px 8px;white-space:nowrap;background:color-mix(in srgb,var(--rp-warn) 8%,transparent)}
.proof,.fampair{display:grid;grid-template-columns:1fr 1fr;gap:0}
@media (max-width:820px){.proof,.fampair{grid-template-columns:1fr}}
.side,.famcol{padding:18px 24px 20px;min-width:0}
.side + .side,.famcol + .famcol{border-left:1px solid var(--rp-rule-soft)}
@media (max-width:820px){.side + .side,.famcol + .famcol{border-left:0;border-top:1px solid var(--rp-rule-soft)}}
.sidehead{display:flex;align-items:baseline;gap:9px;margin-bottom:14px}
.ab{width:17px;height:17px;border-radius:2px;display:inline-grid;place-items:center;font-size:10px;color:var(--rp-sheet);background:var(--rp-faint)}
.side.is-after .ab{background:var(--rp-accent)}
.sidehead h4{margin:0;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--rp-mut);font-weight:500;
  font-family:ui-monospace,Menlo,monospace}
.famhead{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--rp-mut);margin-bottom:12px}
.famcol:last-child .famhead{color:var(--rp-warn)}
.cellrow{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.cell{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0;max-width:100%}
.swatch{background-image:
    linear-gradient(45deg,var(--rp-check) 25%,transparent 25%,transparent 75%,var(--rp-check) 75%),
    linear-gradient(45deg,var(--rp-check) 25%,transparent 25%,transparent 75%,var(--rp-check) 75%);
  background-size:12px 12px;background-position:0 0,6px 6px;padding:11px;border-radius:2px;overflow-x:auto;max-width:100%}
.spec{background:var(--spec-ground);padding:10px;border-radius:1px;width:max-content;min-width:100%;
  font-family:Inter,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-feature-settings:"cv11","ss01","ss03";font-size:13px;line-height:normal;color:var(--text-strong)}
.spec.z2{zoom:2;padding:6px}
figcaption{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--rp-faint)}
.fakecard{background:var(--bg-surface);padding:2px}
.fakepop{background:var(--bg-surface-raised);border:1px solid var(--border-subtle);border-radius:6px;width:210px;padding:4px 0}
.statewrap{border-top:1px solid var(--rp-rule-soft);padding:18px 24px 22px;background:var(--rp-sheet-2)}
.statewrap > .eyebrow{margin-bottom:12px}
.states{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start}
.statecol{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%}
.statecap{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--rp-mut)}
.statepair{display:flex;flex-direction:column;gap:7px;min-width:0}
.staterow{display:flex;align-items:center;gap:8px;min-width:0}
.staterow .ab{flex:0 0 auto;width:15px;height:15px;font-size:9px}
.staterow:last-child .ab{background:var(--rp-accent)}
.staterow .swatch{padding:8px;min-width:0}
.note{padding:16px 24px 20px;border-top:1px solid var(--rp-rule-soft);font-size:14px;color:var(--rp-dim);max-width:82ch}
.near{font-size:12px;color:var(--rp-faint)}
.foot{margin-top:52px;padding-top:20px;border-top:1px solid var(--rp-rule);font-size:13px;color:var(--rp-mut)}
.foot b{color:var(--rp-text);font-weight:500}
details{margin-top:16px}
summary{cursor:pointer;color:var(--rp-accent);font-size:13px;width:fit-content;border-radius:2px}
summary:focus-visible{outline:2px solid var(--rp-accent);outline-offset:3px}
.tablewrap{margin-top:14px;max-height:520px;overflow:auto;border:1px solid var(--rp-rule);border-radius:2px;background:var(--rp-sheet)}
table.sites{border-collapse:collapse;width:100%;font-size:11.5px}
table.sites th{position:sticky;top:0;background:var(--rp-sheet-2);text-align:left;padding:8px 10px;
  border-bottom:1px solid var(--rp-rule);font-weight:500;color:var(--rp-mut);font-size:10px;letter-spacing:.09em;
  text-transform:uppercase;white-space:nowrap}
table.sites td{padding:5px 10px;border-bottom:1px solid var(--rp-rule-soft);vertical-align:top;color:var(--rp-dim)}
.c-line{text-align:right;color:var(--rp-faint);white-space:nowrap}
.c-stat{white-space:nowrap}
.r-swapped .c-stat{color:var(--rp-accent)}
.r-needs-variant .c-stat{color:var(--rp-warn)}
.c-kit{color:var(--rp-mut)}
.c-file{word-break:break-all}
/* Forced states: the app paints these on :hover / :focus-visible / :active,
   which a static page never enters, so each is restated on a wrapper class.
   Add a line here for any hover utility a new specimen wears. */
.st-hover [class*="hover:bg-[color:var(--bg-hover)]"]{background-color:var(--bg-hover)}
.st-hover [class*="hover:bg-[color:var(--bg-selected)]"]{background-color:var(--bg-selected)}
.st-hover [class*="hover:bg-[color:var(--bg-surface-raised)]"]{background-color:var(--bg-surface-raised)}
.st-hover [class*="hover:text-[color:var(--text-strong)]"]{color:var(--text-strong)}
.st-hover [class*="hover:text-[color:var(--text-default)]"]{color:var(--text-default)}
.st-hover [class*="hover:border-[color:var(--border-strong)]"]{border-color:var(--border-strong)}
.st-focus [class*="focus-visible:focus-ring"]{outline:var(--focus-ring);outline-offset:var(--focus-ring-offset)}
.st-focus [class*="focus-visible:focus-ring-inset"]{outline-offset:calc(-1 * var(--focus-ring-offset))}
.st-press .interactive:not(.control-raised):not(.control-edge){transform:scale(.97)}
@media (prefers-reduced-motion: reduce){.rp *,.spec *{transition-duration:0.01ms!important;animation-duration:0.01ms!important}}
`

// ── assemble ─────────────────────────────────────────────────────────────────
const appCssPath = resolveAppCss()
const grounds = buildGrounds()
const page = [
  `<title>${esc(opts.title)}</title>`,
  `<style>${readFileSync(appCssPath, 'utf8')}</style>`,
  `<style>${grounds.css}</style>`,
  `<style>${PAGE_CSS}</style>`,
  `<main class="rp">`,
  `<header class="masthead">
<div><p class="eyebrow">SprintEngine Studio - design system${opts.sha ? ` - <span class="sha">${esc(opts.sha)}</span>` : ''}</p>
<h1>${esc(opts.title)}</h1></div>
<div><p class="stand">${esc(
    opts.lede ??
      'Everything below is the real thing: the markup was rendered by React from the two revisions - the raw JSX as it stood before, the kit call as it stands now - and painted by the application’s own compiled stylesheet, tokens and all.',
  )}</p>
<p class="stand">Each control is shown on the ground it actually sits on in the app, in light and in dark, at life size and at double, with the states the change touched underneath.</p></div>
<div class="stats">
  <div class="stat is-swap"><span class="stat-n">${nSwap}</span><span class="stat-l">Swapped</span></div>
  <div class="stat"><span class="stat-n">${drawnKept.length}</span><span class="stat-l">Kept raw</span></div>
  ${nUndrawn > 0 ? `<div class="stat"><span class="stat-n">${nUndrawn}</span><span class="stat-l">Kept, not drawn</span></div>` : ''}
  ${nWait > 0 ? `<div class="stat is-wait"><span class="stat-n">${nWait}</span><span class="stat-l">Waiting on a variant</span></div>` : ''}
</div>
${
  laneCounts.length > 0
    ? `<div class="stats">${laneCounts
        .map(
          (l) => `<div class="stat"><span class="stat-n">${l.n}</span><span class="stat-l">${esc(l.name)}</span></div>`,
        )
        .join('')}</div>`
    : ''
}
<p class="method">The specimen grounds are fixed - one light, one dark - whichever theme you are reading this in, because they are the app’s grounds, not the page’s. Hover, focus and pressed are restated on a wrapper class, since a page that is only read never enters them.</p>
</header>`,
]

if (drawnSwaps.length > 0) {
  // Grouped under the kit member that draws them now, when the sweep named one:
  // the reader is asking which components absorbed the hand-rolls, and the
  // group sizes answer it before a single band is read.
  const grouped = drawnSwaps.some((r) => r.kitMember)
  page.push(
    `<div class="secthead"><h2>What changed</h2><p class="lede">${drawnSwaps.length} site${
      drawnSwaps.length === 1 ? '' : 's'
    }, each one a control an existing component, variant, size and tone reproduce exactly${
      grouped ? ', grouped under the kit member that draws it now' : ''
    }.</p></div>`,
  )
  if (!grouped) for (const record of drawnSwaps) page.push(band(record))
  else {
    const members = []
    for (const record of drawnSwaps) {
      const name = record.kitMember ?? 'Other'
      const found = members.find((m) => m.name === name)
      if (found) found.rows.push(record)
      else members.push({ name, rows: [record] })
    }
    members.sort((a, b) =>
      b.rows.length === a.rows.length ? (a.name < b.name ? -1 : 1) : b.rows.length - a.rows.length,
    )
    for (const member of members) {
      page.push(
        `<div class="secthead"><h2>${esc(member.name)}</h2><p class="lede">${member.rows.length} site${
          member.rows.length === 1 ? '' : 's'
        }.</p></div>`,
      )
      for (const record of member.rows) page.push(band(record))
    }
  }
}

if (drawnKept.length > 0) {
  page.push(
    `<div class="secthead"><h2>Left alone, and why</h2><p class="lede">${drawnKept.length} control${
      drawnKept.length === 1 ? '' : 's'
    } stayed raw. There is no forced pairing to show: each is a shape the kit does not ship, or an element the kit would only put chrome on, so it is shown once, as it stands, under the reason.</p></div>`,
  )
  for (const record of drawnKept) page.push(keptCard(record))
}

if (drawnFamilies.length > 0) {
  page.push(
    `<div class="secthead"><h2>Waiting on a kit variant</h2><p class="lede">These are not hand-rolls anyone defended - they are shapes the kit does not ship yet. Each pair puts the raw control as it stands today beside the closest thing the kit does ship, with the raw classes dropped, so the cost of forcing it is visible rather than argued.</p></div>`,
  )
  for (const record of drawnFamilies) page.push(family(record))
}

page.push(`<footer class="foot">
<p><b>${nSwap} swapped</b>, <b>${nKept} kept</b>${
  nWait > 0 ? `, <b>${nWait} waiting on kit variants</b>` : ''
}, ${rows.length} sites in all${
  laneCounts.length > 0 ? ` - ${laneCounts.map((l) => `${l.n} ${esc(l.name.toLowerCase())}`).join(', ')}` : ''
}.</p>
<details><summary>full site list</summary><div class="tablewrap">${table}</div></details>
</footer>`)
page.push('</main>')

mkdirSync(path.dirname(opts.out), { recursive: true })
const html = page.join('\n')
writeFileSync(opts.out, html)

// ── self-check ───────────────────────────────────────────────────────────────
// A page that renders nothing still writes a file, so the exit code has to
// mean something. These are the failures the working renderer actually hit.
const problems = []
if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)) problems.push('the fragment carries a document wrapper')
if (/<pre[\s>]|<code[\s>]/i.test(html)) problems.push('the page carries a code block; the specimens are the content')
if (missing.length > 0) problems.push(`the specimen module exports no ${[...new Set(missing)].join(', ')}`)
if (grounds.counts.light === 0 || grounds.counts.dark === 0)
  problems.push('a ground is empty; check the --tokens files and their :root selectors')
for (const token of new Set(
  [...drawnSwaps, ...drawnKept, ...drawnFamilies].map((r) => r.specimen.ground).filter(Boolean),
)) {
  if (!grounds.css.includes(`${token}:`)) problems.push(`a specimen sits on ${token}, which the grounds do not declare`)
}
console.log(
  `wrote ${opts.out} (${html.length} bytes) - ${rows.length} sites, ${drawnSwaps.length} bands, ` +
    `${drawnKept.length} kept, ${drawnFamilies.length} families, ${Object.keys(SPECS).length} specimens, ` +
    `grounds ${grounds.counts.light} light / ${grounds.counts.dark} dark, app css ${path.basename(appCssPath)}`,
)
if (problems.length > 0) {
  for (const problem of problems) console.error(`  problem: ${problem}`)
  process.exitCode = 1
}
