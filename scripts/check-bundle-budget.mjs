#!/usr/bin/env node
// Boot-footprint ratchet (Phase 8). The eager renderer entry chunk must not pull
// in heavy, on-demand-only dependencies, and must stay under a size ceiling.
// Runs after `electron-vite build` (chained in the "build" script) so CI's build
// step enforces it. If this fails, a panel/dep that should be code-split behind
// React.lazy has been statically imported into the boot graph — load it lazily
// (see SettingsOverlay / WorkspaceManager NewWorkspacePanel for the pattern).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS_DIR = 'out/renderer/assets'
// 2048 is a round number, not a measurement, and MC-2075 measured what it stands
// in for: the whole 2072 KB eager chunk costs ~14 ms to compile (33 ms with every
// function eagerly compiled) inside a 603–710 ms boot, so ~0.7 ms per 100 KB
// trimmed. The FORBIDDEN list below is what actually earns its keep here.
// Re-baseline this number deliberately, with `node scripts/measure-startup.mjs`
// output attached — never as a quiet bump to make a red build green.
const CEILING_KB = 2048

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
    allow: ['.monaco-editor'],
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
