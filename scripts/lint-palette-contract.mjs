#!/usr/bin/env node
// Palette contract guard for the shared UI redesign.
//
// Asserts every command id advertised by `CommandPalette.tsx` is handled by
// at least one panel under `src/renderer/src/components/panels/`. Without
// this guard, palette entries can silently no-op when their panel handler is
// removed or renamed (the regression chain documented in
// `.multi-code/sprintengine/2026-05-12-linear-grade-ui-redesign2/reviews/visual-regression-validation-1.md`).
//
// The check is bidirectional: palette ⊆ handlers AND handlers ⊆ palette,
// because a panel that handles a command id with no palette entry is dead
// code waiting to be a stale relocation.
//
// Usage:
//   node scripts/lint-palette-contract.mjs           # exit 1 on mismatch
//   node scripts/lint-palette-contract.mjs --report  # exit 0; report only

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Switchboard/Watchtower palette rows are registered through the module path
// since MC-1533 (switchboard-module.ts), so their dispatch ids live there;
// the shell palette carries the Sprint Engine rows.
const PALETTE_FILES = [
  'src/renderer/src/components/CommandPalette.tsx',
  'src/renderer/src/modules/switchboard-module.ts',
]
const PANEL_FILES = [
  'src/renderer/src/components/panels/SwitchboardBoardPanel.tsx',
  'src/renderer/src/components/panels/WatchtowerPanel.tsx',
  'src/renderer/src/components/panels/SprintEngineBoardPanel.tsx',
]

// Command ids match `<panel>.<verb>.<noun>` with lowercase letters, dots and
// hyphens. Anchored on the surrounding quote to avoid false matches in prose.
const COMMAND_ID_RE = /'(switchboard|watchtower|sprintengine)\.[a-z0-9.\-]+'/g

function extractIds(source) {
  const ids = new Set()
  let match
  COMMAND_ID_RE.lastIndex = 0
  while ((match = COMMAND_ID_RE.exec(source))) {
    ids.add(match[0].slice(1, -1))
  }
  return ids
}

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')

const paletteIds = new Set()
for (const relativePath of PALETTE_FILES) {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
  for (const id of extractIds(source)) paletteIds.add(id)
}

const handlerIds = new Set()
for (const relativePath of PANEL_FILES) {
  const fullPath = resolve(process.cwd(), relativePath)
  const source = readFileSync(fullPath, 'utf8')
  for (const id of extractIds(source)) handlerIds.add(id)
}

const missingHandler = [...paletteIds].filter((id) => !handlerIds.has(id)).sort()
const missingPalette = [...handlerIds].filter((id) => !paletteIds.has(id)).sort()

process.stdout.write('\nPalette contract guard summary\n')
process.stdout.write(`  palette commands: ${paletteIds.size}\n`)
process.stdout.write(`  panel handlers:   ${handlerIds.size}\n`)
process.stdout.write(`  missing handler:  ${missingHandler.length}\n`)
process.stdout.write(`  missing palette:  ${missingPalette.length}\n`)

if (missingHandler.length > 0) {
  process.stdout.write('\nPalette commands without a panel handler:\n')
  for (const id of missingHandler) process.stdout.write(`  ${id}\n`)
}
if (missingPalette.length > 0) {
  process.stdout.write('\nPanel handlers without a palette command:\n')
  for (const id of missingPalette) process.stdout.write(`  ${id}\n`)
}

const violations = missingHandler.length + missingPalette.length
if (violations > 0) {
  process.stdout.write(
    '\nFix by either removing the unmatched command id or by adding the matching\n' +
      'entry on the other side. Palette commands without handlers silently no-op;\n' +
      'panel handlers without palette commands are stale relocations.\n',
  )
}

const exitCode = !REPORT_ONLY && violations > 0 ? 1 : 0
process.exit(exitCode)
