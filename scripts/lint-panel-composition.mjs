#!/usr/bin/env node
// Panel composition guard for the shared UI redesign.
//
// Asserts every operational panel under `src/renderer/src/components/panels/`
// either:
//   - imports `PanelHeader` from `../ui` (the canonical chrome), or
//   - is explicitly allow-listed below with a reason.
//
// A panel that hand-rolls its own header has, in practice, also hand-rolled
// status dots, density, and accent treatment — so this guard catches the
// composition regression that the design-token lint cannot see (because no
// hex literal or uppercase-tracking token is emitted).
//
// Usage:
//   node scripts/lint-panel-composition.mjs           # exit 1 on violation
//   node scripts/lint-panel-composition.mjs --report  # exit 0; report only

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PANELS_DIR = resolve(process.cwd(), 'src/renderer/src/components/panels')

// Files exempt from the rule with reasons. Keep this list small and
// justified — when the surface is rebuilt, remove the entry.
const ALLOW_LIST = new Map([
  ['AgentPanel.tsx', 'Sidebar-style placeholder panel; no operational chrome.'],
  ['EditorPanel.tsx', 'Hosts Monaco; chrome is the editor surround, not a PanelHeader.'],
  ['TerminalView.tsx', 'Hosts xterm; chrome is the terminal surround, not a PanelHeader.'],
  ['PlainTerminalPanel.tsx', 'Hosts xterm; chrome is the terminal surround, not a PanelHeader.'],
  ['FileExplorer.tsx', 'Tree surface; rebuild scheduled in the app-wide audit plan.'],
  ['GitPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 7).'],
  ['GitConflictResolverPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 7).'],
  ['ContentSearchPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 8).'],
  ['MemoryGraphPanel.tsx', 'Graph canvas surface; rebuild scheduled in the app-wide audit plan.'],
  ['SprintEnginePlanReaderPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 10).'],
  ['SprintEngineRunSummaryPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 10).'],
])

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')

let files
try {
  files = readdirSync(PANELS_DIR).filter((name) => name.endsWith('.tsx'))
} catch (error) {
  process.stdout.write(
    `Panel directory missing or unreadable: ${PANELS_DIR}\n${error.message}\n`,
  )
  process.exit(2)
}

const findings = []
const summary = []
for (const filename of files.sort()) {
  const fullPath = join(PANELS_DIR, filename)
  const source = readFileSync(fullPath, 'utf8')
  const importsPanelHeader = /\bPanelHeader\b/.test(source) && /from '\.\.\/ui(?:\/index)?'/.test(source)
  const allowed = ALLOW_LIST.has(filename)

  if (importsPanelHeader) {
    summary.push({ filename, status: 'ok' })
    continue
  }
  if (allowed) {
    summary.push({ filename, status: 'allowed', reason: ALLOW_LIST.get(filename) })
    continue
  }
  summary.push({ filename, status: 'missing' })
  findings.push(filename)
}

process.stdout.write('\nPanel composition guard summary\n')
for (const entry of summary) {
  if (entry.status === 'ok') {
    process.stdout.write(`  ${entry.filename}: ok (imports PanelHeader)\n`)
  } else if (entry.status === 'allowed') {
    process.stdout.write(`  ${entry.filename}: allowed — ${entry.reason}\n`)
  } else {
    process.stdout.write(`  ${entry.filename}: MISSING PanelHeader import\n`)
  }
}
process.stdout.write(`Total violations: ${findings.length}\n`)

if (findings.length > 0) {
  process.stdout.write(
    '\nFix by composing the panel from `PanelHeader` (from `../ui`) and the\n' +
      'shared primitives, or add an explicit allow-list entry in\n' +
      'scripts/lint-panel-composition.mjs with a reason and a target plan.\n',
  )
}

const exitCode = !REPORT_ONLY && findings.length > 0 ? 1 : 0
process.exit(exitCode)
