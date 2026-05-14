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
  ['AgentPanel.tsx', 'Hosts an agent terminal (TerminalView); chrome is the terminal surround, not a PanelHeader.'],
  // Note: LearnCenter lives at src/renderer/src/components/learn/LearnCenter.tsx
  // and falls outside this script's PANELS_DIR scope. Recorded here so future
  // relocations into panels/ inherit the rationale instead of being flagged.
  ['LearnCenter.tsx', 'Settings tab body (mounted inside SettingsPanel); chrome is provided by the parent settings shell, not a PanelHeader. Currently lives at components/learn/LearnCenter.tsx, outside this guard\'s scope.'],
  // Note: NewWorkspacePanel lives at workspace/NewWorkspacePanel.tsx and is a
  // multi-step wizard, not an operational panel. The wizard chrome is a
  // brand-led header + WizardProgress (stepper indicator), which is the
  // justified Stepper alternative offered in the T22 plan instead of
  // PanelHeader + Tabs. Recorded here for parity with similar non-panels/
  // surfaces.
  ['NewWorkspacePanel.tsx', 'Multi-step workspace creation wizard; chrome is a brand-led header + WizardProgress stepper, not a PanelHeader. Lives at components/workspace/NewWorkspacePanel.tsx, outside this guard\'s scope.'],
  ['EditorPanel.tsx', 'Hosts Monaco; chrome is the editor surround, not a PanelHeader.'],
  ['TerminalView.tsx', 'Hosts xterm with tokenised drag/drop and folder-blocked chrome; xterm owns the canvas palette, not PanelHeader.'],
  ['PlainTerminalPanel.tsx', 'Hosts xterm with tokenised drag/drop and folder-blocked chrome; xterm owns the canvas palette, not PanelHeader.'],
  ['FileExplorer.tsx', 'Tree surface with a bespoke folder-root + search bar header. Chrome was tokenised in T23 (hex=0); a deeper rebuild around PanelHeader + Tabs is still scheduled in the app-wide audit plan.'],
  // GitPanel.tsx now imports PanelHeader (T20). The allow-list entry has been
  // removed; the lint script will detect the import and mark the file ok.
  ['GitConflictResolverPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 7).'],
  ['ContentSearchPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 8).'],
  ['MemoryGraphPanel.tsx', 'Graph canvas surface; rebuild scheduled in the app-wide audit plan.'],
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
