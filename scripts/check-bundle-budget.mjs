#!/usr/bin/env node
// Boot-footprint ratchet (Phase 8). Two jobs, and they are not equally load-
// bearing:
//
//   1. DRIFT DETECTION (the real one). The eager renderer entry chunk must not
//      pull in heavy, on-demand-only dependencies — see FORBIDDEN below. If that
//      half fails, a panel or dep that belongs behind React.lazy has been
//      statically imported into the boot graph; load it lazily (see
//      WorkspaceManager's React.lazy of SettingsModalSurface / CommandPalette
//      for the pattern).
//   2. A size ceiling, which stands in for boot cost and is a much weaker proxy
//      for it than its precision suggests. See CEILING_KB for the numbers.
//
// Runs after `electron-vite build` (chained in the "build" script) so CI's build
// step enforces it.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS_DIR = 'out/renderer/assets'
// Re-baselined 2048 → 2176 on 2026-08-06 (MC-2170), with the measurement the old
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
// MC-2075 measured 14 ms for 2072 KB and 710 ms to screen; 21 KB more moved
// compile by ~0.1 ms and boot by nothing outside run-to-run spread. That is
// ~0.7 ms per 100 KB trimmed. About 250 ms of that 288 ms span is module-level
// EVALUATION, not parse — so shaving KB attacks the small half. Activation
// events (a module registers when its surface is first used) attack the large
// one.
//
// So the number is deliberately set just above the current size: enough headroom
// that ordinary growth does not re-trip it, tight enough that a real regression
// does. The FORBIDDEN list below is what actually earns its keep here, and it is
// unchanged — micromark, monaco and d3-force never belong in the boot graph at
// any size.
//
// The honest gate is time, not KB: `scripts/measure-startup.mjs` produces a
// median in ~30 s, and a budget on "process start → app on screen" would say
// what this number only gestures at. That is the next step, not this one.
//
// Re-baseline deliberately, with fresh `measure-startup.mjs` output attached —
// never as a quiet bump to make a red build green.
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
]

let files
try {
  files = readdirSync(ASSETS_DIR)
} catch {
  console.error(`[bundle-budget] ${ASSETS_DIR} not found — run the build first.`)
  process.exit(1)
}

const indexChunks = files.filter((f) => /^index-.*\.js$/.test(f))
if (indexChunks.length === 0) {
  console.error('[bundle-budget] no eager index chunk found in build output.')
  process.exit(1)
}

// The eager entry chunk is the largest index-*.js.
const eager = indexChunks
  .map((f) => ({ f, size: statSync(join(ASSETS_DIR, f)).size }))
  .sort((a, b) => b.size - a.size)[0]
const code = readFileSync(join(ASSETS_DIR, eager.f), 'utf8')
const kb = Math.round(eager.size / 1024)

const problems = []
if (kb > CEILING_KB) {
  problems.push(`eager chunk is ${kb} KB, over the ${CEILING_KB} KB ceiling`)
}
for (const { sig, why, allow } of FORBIDDEN) {
  const haystack = (allow ?? []).reduce((acc, benign) => acc.split(benign).join(''), code)
  if (haystack.includes(sig)) problems.push(`eager chunk contains "${sig}" — ${why}`)
}

if (problems.length > 0) {
  console.error(`[bundle-budget] FAIL (${eager.f}, ${kb} KB):`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

console.log(`[bundle-budget] ok — eager chunk ${eager.f} is ${kb} KB with no forbidden deps.`)
