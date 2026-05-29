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
const CEILING_KB = 2048

// Signatures of heavy deps that must only ever appear in lazy chunks.
const FORBIDDEN = [
  { sig: 'micromark', why: 'markdown renderer (react-markdown) — keep it in lazy panels' },
  { sig: 'monaco', why: 'Monaco editor — keep it in the EditorPanel chunk' },
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
for (const { sig, why } of FORBIDDEN) {
  if (code.includes(sig)) problems.push(`eager chunk contains "${sig}" — ${why}`)
}

if (problems.length > 0) {
  console.error(`[bundle-budget] FAIL (${eager.f}, ${kb} KB):`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

console.log(`[bundle-budget] ok — eager chunk ${eager.f} is ${kb} KB with no forbidden deps.`)
