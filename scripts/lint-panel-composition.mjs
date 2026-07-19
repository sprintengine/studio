#!/usr/bin/env node
// Panel composition guard for the shared UI redesign.
//
// Two rules:
//
//   (a) Every operational panel under `src/renderer/src/components/panels/`
//       either imports `PanelHeader` from `../ui` (the canonical chrome) or
//       is explicitly allow-listed below with a reason. A panel that hand-
//       rolls its own header has, in practice, also hand-rolled status dots,
//       density, and accent treatment — so this guard catches the composition
//       regression that the design-token lint cannot see.
//
//   (b) `WorkspaceActions` declares at most five at-rest control groups via
//       `{/* top-bar-group: <name> */}` JSX comment markers. The cap matches
//       the architect plan and BRAND-APP rule "≤ 5 controls per panel header".
//       Adding a sixth marker fails this guard; renaming or removing one
//       requires the brand docs (panel-design-system.md TopBar inventory) to
//       move in lockstep. (These groups were hoisted out of the retired
//       WorkspaceTopBar row into the merged AppTitleBar title strip.)
//
// Usage:
//   node scripts/lint-panel-composition.mjs           # exit 1 on violation
//   node scripts/lint-panel-composition.mjs --report  # exit 0; report only

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const PANELS_DIR = resolve(process.cwd(), 'src/renderer/src/components/panels')
const WORKSPACE_TOPBAR_PATH = resolve(
  process.cwd(),
  'src/renderer/src/components/workspace/WorkspaceActions.tsx',
)
const TOP_BAR_GROUP_MARKER = /\btop-bar-group:\s*([a-z0-9-]+)\b/g
const TOP_BAR_GROUP_CAP = 5
// Canonical at-rest group inventory. Mirrors the BRAND-APP rule and the
// panel-design-system.md TopBar table. Adding to this set requires a brand
// review.
const CANONICAL_TOP_BAR_GROUPS = new Set([
  'activity-and-views',
  'communication',
  'agent-spawn',
  // `account-and-settings` retired: account + Settings relocated to the sidebar
  // bottom (SidebarAccountBar) in the Cursor-parity re-layout. See
  // knowledge/brand/panel-design-system.md TopBar inventory.
])

// Files exempt from the rule with reasons. Keep this list small and
// justified — when the surface is rebuilt, remove the entry.
const ALLOW_LIST = new Map([
  ['BacklogCreateDialog.tsx', 'Modal-based "New backlog item" capture dialog (mirrors WatchtowerPanel/CreateInboxDialog); chrome is owned by Modal + ModalHeader, not a PanelHeader. It is a dialog rendered by BacklogPanel, not an operational panel.'],
  ['AgentPanel.tsx', 'Hosts an agent terminal (TerminalView); chrome is the terminal surround, not a PanelHeader.'],
  ['AgentChatView.tsx', 'Agent-tab body for conversation agents (sibling of AgentPanel/TerminalView); the FlexLayout tab owns identity, so the surface uses a compact composer + session-status bar, not a PanelHeader.'],
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
  ['GitPanel.tsx', 'Git workspace surface still owns branch/status/filter chrome directly; scheduled for the Git panel rebuild before enforcing PanelHeader.'],
  ['GitGraphView.tsx', 'Graph sub-view rendered inside GitPanel; the parent panel owns the operational chrome.'],
  ['GitConflictResolverPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 7).'],
  ['ContentSearchPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 8).'],
  ['MemoryGraphPanel.tsx', 'Graph canvas surface; rebuild scheduled in the app-wide audit plan.'],
  ['SprintEngineTaskGraphView.tsx', 'Sub-view of SprintEngineBoardPanel; rendered inside the parent panel\'s body, so PanelHeader is owned by the parent. Extracted to its own file for maintainability.'],
  ['SprintEngineInspectorPanel.tsx', 'Inspector aside of SprintEngineBoardPanel; rendered as the right-hand detail pane, so PanelHeader chrome is owned by the parent panel. Extracted to its own file in Stage 2.1 of the app-wide dedup plan.'],
  ['runSummaryCharts.tsx', 'Chart primitives rendered inside SprintEngineRunSummaryPanel; parent panel owns PanelHeader chrome.'],
  ['runPullRequest.tsx', 'Pull-request controls + hooks rendered inside SprintEngineBoardPanel: a view chip in the run-hero strip and a primary action in the run-complete banner; the parent panel owns the surrounding chrome.'],
  ['SprintEngineBoardPanel.tsx', 'Carries a bespoke run-hero strip (project name + run-phase lifecycle glyph + progress hairline + settings overflow) above the Tabs strip in place of PanelHeader. The generic title/count chrome was redundant with the FlexLayout tab label and per-tab content, and the hero conveys identity richer than PanelHeader allows.'],
  ['SwitchboardWorkspacePanel.tsx', 'Thin Watchtower / Switchboard wrapper that renders the icon Tabs sub-nav at the top and delegates body chrome (PanelHeader, counts, etc.) to the active child panel. Mirrors SprintEngineBoardPanel\'s ownership pattern: the wrapper owns the row chrome, each child owns its surface.'],
  ['ReviewPanel.tsx', 'The review workspace hides the FlexLayout tab strip and owns the whole pane; the guided walkthrough carries a bespoke 46px top bar (change identity + stats/complexity + side-by-side/inline toggle + Re-run) in place of PanelHeader. Mirrors SprintEngineBoardPanel/EditorPanel: the surface owns richer identity chrome than PanelHeader allows.'],
])

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')

let files
try {
  // Focused component tests live beside the panels they cover; they are not
  // operational panel surfaces, so the PanelHeader contract does not apply.
  files = readdirSync(PANELS_DIR).filter(
    (name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'),
  )
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

// (b) WorkspaceActions at-rest control-group cap.
let topBarFindings = 0
try {
  const topBarSrc = readFileSync(WORKSPACE_TOPBAR_PATH, 'utf8')
  const seenGroups = []
  TOP_BAR_GROUP_MARKER.lastIndex = 0
  let markerMatch
  while ((markerMatch = TOP_BAR_GROUP_MARKER.exec(topBarSrc))) {
    seenGroups.push(markerMatch[1])
  }
  const unique = new Set(seenGroups)
  const unexpected = [...unique].filter((g) => !CANONICAL_TOP_BAR_GROUPS.has(g))
  const missing = [...CANONICAL_TOP_BAR_GROUPS].filter((g) => !unique.has(g))
  process.stdout.write('\nWorkspaceActions control-group cap\n')
  process.stdout.write(`  cap:        ≤ ${TOP_BAR_GROUP_CAP} at-rest groups (BRAND-APP)\n`)
  process.stdout.write(`  declared:   ${seenGroups.length} marker(s); ${unique.size} unique\n`)
  process.stdout.write(`  canonical:  ${[...CANONICAL_TOP_BAR_GROUPS].join(', ')}\n`)
  if (unique.size > TOP_BAR_GROUP_CAP) {
    process.stdout.write(
      `  VIOLATION: ${unique.size} unique top-bar-group markers (> ${TOP_BAR_GROUP_CAP}).\n` +
        '             Density drift — collapse two groups or document the new group\n' +
        '             in CANONICAL_TOP_BAR_GROUPS + panel-design-system.md TopBar inventory.\n',
    )
    topBarFindings += 1
  }
  if (unexpected.length > 0) {
    process.stdout.write(
      `  VIOLATION: unknown group(s) — ${unexpected.join(', ')}\n` +
        '             Either rename to a canonical key or add to CANONICAL_TOP_BAR_GROUPS\n' +
        '             with a brand-doc inventory entry.\n',
    )
    topBarFindings += 1
  }
  if (missing.length > 0 && unique.size > 0) {
    process.stdout.write(
      `  VIOLATION: canonical group(s) absent — ${missing.join(', ')}\n` +
        '             Add the marker or amend CANONICAL_TOP_BAR_GROUPS to match.\n',
    )
    topBarFindings += 1
  }
  if (topBarFindings === 0) {
    process.stdout.write('  ok — all canonical groups present, no extras.\n')
  }
} catch (error) {
  process.stdout.write(
    `\nWorkspaceActions control-group cap: skipped (could not read ${WORKSPACE_TOPBAR_PATH}: ${error.message})\n`,
  )
  topBarFindings += 1
}

const exitCode = !REPORT_ONLY && (findings.length > 0 || topBarFindings > 0) ? 1 : 0
process.exit(exitCode)
