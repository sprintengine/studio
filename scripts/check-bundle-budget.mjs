#!/usr/bin/env node
// Boot-footprint ratchet (Phase 8). Two jobs, and they are not equally load-
// bearing:
//
//   1. DRIFT DETECTION (the real one). The eager renderer boot graph must not
//      pull in heavy, on-demand-only dependencies — see FORBIDDEN below. If that
//      half fails, a panel or dep that belongs behind React.lazy has been
//      statically imported into the boot graph; load it lazily (see
//      WorkspaceManager's React.lazy of SettingsModalSurface / CommandPalette
//      for the pattern).
//   2. A size ceiling, which stands in for boot cost and is a much weaker proxy
//      for it than its precision suggests. See CEILING_KB for the numbers.
//
// WHAT "EAGER" MEANS HERE, and why it is read out of the HTML rather than
// guessed from a filename. The shell's boot graph is exactly what
// `out/renderer/index.html` fetches before the app can run: its one entry
// `<script type="module">` plus every `<link rel="modulepreload">` Rollup
// emitted beside it, which are the shared chunks that entry statically imports.
// That set used to be a single `index-*.js`, so "the largest index-*.js" was a
// fair stand-in for it and this script used one. It stopped being fair when the
// canvas worker became a third HTML entry (canvas-pane): Rollup hoisted ~227 KB
// of React out of the entry into a chunk shared by all three and modulepreloaded
// it from `index.html`, which made the entry alone LOOK ~227 KB cheaper than the
// boot it describes. The same change also produced LAZY chunks named
// `index-*.js` — the Mermaid importer is one, at ~1 MB — so the old "largest
// index-*.js" heuristic was one growth spurt away from measuring a chunk the
// shell never loads. Reading the HTML measures the real thing and needs no
// heuristic; it is the same quantity the numbers under CEILING_KB were measured
// against, not a new one.
//
// The stylesheet `index.html` links is deliberately NOT counted: the ceiling
// stands for the JS parse-and-evaluate span, and CSS has never been in it. The
// FORBIDDEN scan is over JS for the same reason — every signature in it is a
// string from a compiled module.
//
// Runs after `electron-vite build` (chained in the "build" script) so CI's build
// step enforces it.

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const RENDERER_DIR = 'out/renderer'
const ENTRY_HTML = join(RENDERER_DIR, 'index.html')
// Re-baselined 2048 → 2176 on 2026-08-06, with the measurement the old
// number never had. 2048 was a round number nobody had connected to a cost, and
// it had been silently breached on `main` for weeks — 2071 KB at 1278f41c6,
// before any one branch's work.
//
// What the ceiling stands for, measured on this tree (Apple M4, Electron 41.3.0,
// `node scripts/measure-startup.mjs --runs 3` and `--compile-cache`, eager chunk
// 2093 KB):
//
//   process start → app on screen        671 ms   (610–791)
//   document start → entry script running  288 ms   ← the span the ceiling guards
//   compile of the whole 2093 KB chunk    14.4 ms
//   the most a V8 code cache could remove 13.6 ms
//
// An earlier measurement found 14 ms for 2072 KB and 710 ms to screen; 21 KB more moved
// compile by ~0.1 ms and boot by nothing outside run-to-run spread. That is
// ~0.7 ms per 100 KB trimmed. About 250 ms of that 288 ms span is module-level
// EVALUATION, not parse — so shaving KB attacks the small half. Activation
// events (a module registers when its surface is first used) attack the large
// one.
//
// So the number is deliberately set just above the current size: enough headroom
// that ordinary growth does not re-trip it, tight enough that a real regression
// does. The FORBIDDEN list below is what actually earns its keep here —
// micromark, monaco, d3-force and the canvas editor never belong in the boot
// graph at any size.
//
// The honest gate is time, not KB: `scripts/measure-startup.mjs` produces a
// median in ~30 s, and a budget on "process start → app on screen" would say
// what this number only gestures at. That is the next step, not this one.
//
// Re-baseline deliberately, with fresh `measure-startup.mjs` output attached —
// never as a quiet bump to make a red build green.
//
// 2026-09-17 (canvas-pane): the MEASUREMENT changed, the number did not. The
// eager set is now summed from `index.html` as described at the top of this
// file; on this tree that is a 1613 KB entry plus a 227 KB modulepreloaded
// shared chunk, 1840 KB in total, comfortably inside the same 2160 KB. Nothing
// was re-baselined, and the ceiling must not be moved to accommodate a measured
// total that exceeds it — report the numbers and leave it failing instead.
const CEILING_KB = 2160

// Signatures of heavy deps that must only ever appear in lazy chunks.
// `allow` lists benign exact substrings that happen to contain the signature
// but are NOT the heavy dependency's code (e.g. a CSS-class selector that boot
// code references by name). They are stripped before the membership test so the
// ratchet stays precise: it still fails on a real eager import of the dep, but
// does not trip on an incidental class-name string.
const FORBIDDEN = [
  { sig: 'micromark', why: 'markdown renderer (react-markdown) — keep it in lazy panels' },
  {
    sig: 'monaco',
    why: 'Monaco editor — keep it in the EditorPanel chunk',
    // `.monaco-editor` is the DOM class Monaco renders at runtime. Boot-level
    // clipboard/paste routing (src/renderer/src/utils/clipboardPasteBridge.ts)
    // references it via closest('.xterm, .monaco-editor') to detect paste
    // targets owned by the editor. That selector string bundles no editor code,
    // so it must not register as Monaco landing in the eager chunk. The actual
    // editor stays behind the EditorPanel / GitConflictResolverPanel React.lazy
    // boundaries; statically importing either into boot reintroduces real
    // `monaco.` API references that survive this allowance and fail the ratchet.
    // `@monaco-editor/react` is the bare SPECIFIER the third-party import map
    // bridges (D6): src/renderer/src/modules/third-party-loader.ts holds it as
    // a key in a table of `() => import(…)` thunks, so what lands in the boot
    // chunk is that string plus a lazy-chunk reference — the wrapper and the
    // editor behind it are a separate chunk fetched on the first third-party
    // module load. Same shape of allowance as `.monaco-editor` above: a real
    // eager import still drags in `monaco.` API references that neither
    // allowance strips.
    allow: ['.monaco-editor', '@monaco-editor/react'],
  },
  { sig: 'forceSimulation', why: 'd3-force — keep it in the MemoryGraphPanel chunk' },
  {
    sig: 'ASSETS_FALLBACK_URL',
    // The canvas editor (`@excalidraw/excalidraw`) is the heaviest dependency in
    // the tree and belongs behind the CanvasTab React.lazy boundary. Picking a
    // signature for it takes some care, because our own eager code legitimately
    // carries the obvious candidates: the asset-path bootstrap names
    // `EXCALIDRAW_ASSET_PATH`, the shared path helpers name the `.excalidraw`
    // extension, and the tab kind and module id are both the word `canvas`.
    // This one is the library's own constant for the public CDN it falls back
    // to when a font URL misses — a string literal inside its compiled font
    // loader, which is statically imported by its entry, so it arrives with any
    // eager import of the package and with nothing else.
    why: 'the canvas editor (@excalidraw/excalidraw) — keep it in the CanvasTab chunk',
  },
]

let html
try {
  html = readFileSync(ENTRY_HTML, 'utf8')
} catch {
  console.error(`[bundle-budget] ${ENTRY_HTML} not found — run the build first.`)
  process.exit(1)
}

/**
 * The scripts `index.html` loads before the app can run, in the order it lists
 * them: the module entry, then every chunk it modulepreloads.
 *
 * Attribute order is not assumed — Rollup writes `type` before `src` on the
 * entry and `rel` before `href` on a preload, but a tag is matched whole and
 * each attribute is read out of it, so a change there shows up as a missing
 * asset rather than as a silently smaller boot graph.
 */
function eagerScriptRefs(document) {
  const refs = []
  for (const tag of document.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
    if (src) refs.push(src[1])
  }
  for (const tag of document.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']modulepreload["']/i.test(tag)) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)
    if (href) refs.push(href[1])
  }
  return refs
}

// Relative to the HTML, and refused if it points outside the renderer output:
// this only ever measures files the build produced.
function resolveRef(ref) {
  if (/^[a-z]+:/i.test(ref)) return null
  const rooted = resolve(RENDERER_DIR)
  const path = ref.startsWith('/')
    ? join(rooted, ref.slice(1))
    : resolve(dirname(ENTRY_HTML), ref.split('?')[0].split('#')[0])
  return normalize(path).startsWith(rooted) ? path : null
}

const refs = eagerScriptRefs(html)
if (refs.length === 0) {
  console.error(`[bundle-budget] ${ENTRY_HTML} loads no module script — the build output looks wrong.`)
  process.exit(1)
}

const problems = []
const loaded = []
let total = 0
for (const ref of refs) {
  const path = resolveRef(ref)
  if (!path) {
    problems.push(`${ref} is not a file inside ${RENDERER_DIR}`)
    continue
  }
  let size
  try {
    size = statSync(path).size
  } catch {
    problems.push(`${ref} is loaded by index.html but is not in the build output`)
    continue
  }
  total += size
  const code = readFileSync(path, 'utf8')
  const name = path.slice(resolve(RENDERER_DIR).length + 1)
  loaded.push({ name, kb: Math.round(size / 1024) })
  for (const { sig, why, allow } of FORBIDDEN) {
    const haystack = (allow ?? []).reduce((acc, benign) => acc.split(benign).join(''), code)
    if (haystack.includes(sig)) problems.push(`${name} contains "${sig}" — ${why}`)
  }
}

const kb = Math.round(total / 1024)
if (kb > CEILING_KB) {
  problems.push(`the eager boot graph is ${kb} KB, over the ${CEILING_KB} KB ceiling`)
}

const breakdown = loaded.map((entry) => `${entry.name} ${entry.kb} KB`).join(' + ')

if (problems.length > 0) {
  console.error(`[bundle-budget] FAIL (${kb} KB eager: ${breakdown}):`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

console.log(`[bundle-budget] ok — index.html loads ${kb} KB eagerly (${breakdown}) with no forbidden deps.`)
