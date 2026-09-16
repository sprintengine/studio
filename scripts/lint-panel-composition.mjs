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
//       `{/* top-bar-group: <name> */}` JSX comment markers. The cap is the
//       BRAND-APP rule "≤ 5 controls per panel header".
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
  // `agent-spawn` retired (MC-2222): its split-button is deleted; spawning is
  // New chat's and the tab strip's job.
  // `account-and-settings` retired: account + Settings relocated to the sidebar
  // bottom (SidebarAccountBar). The set above is the whole TopBar inventory.
])

// Files exempt from the rule with reasons. Keep this list small and
// justified — when the surface is rebuilt, remove the entry.
const ALLOW_LIST = new Map([
  ['BacklogCreateDialog.tsx', 'Modal-based "New backlog item" capture dialog; chrome is owned by Modal + ModalHeader, not a PanelHeader. It is a dialog rendered by BacklogPanel, not an operational panel.'],
  ['AgentPanel.tsx', 'Hosts an agent terminal (TerminalView); chrome is the terminal surround, not a PanelHeader.'],
  ['AgentChatView.tsx', 'Agent-tab body for conversation agents (sibling of AgentPanel/TerminalView); the FlexLayout tab owns identity, so the surface uses a compact composer + session-status bar, not a PanelHeader.'],
  ['EditorPanel.tsx', 'Hosts Monaco; chrome is the editor surround, not a PanelHeader.'],
  ['TerminalView.tsx', 'Hosts xterm with tokenised drag/drop and folder-blocked chrome; xterm owns the canvas palette, not PanelHeader.'],
  ['PlainTerminalPanel.tsx', 'Hosts xterm with tokenised drag/drop and folder-blocked chrome; xterm owns the canvas palette, not PanelHeader.'],
  ['FleetTerminalPanel.tsx', 'Hosts xterm attached to ANOTHER machine (MC-2167). Like the local terminal panes, xterm owns the canvas; the chrome above it is a provenance strip (machine name, link state, watch-only label), which is identity a PanelHeader title cannot carry.'],
  ['FileExplorer.tsx', 'Owns its chrome row deliberately (owner, 2026-09-05): the search field AND the four tree actions share ONE band, in place of a PanelHeader titled with the folder name. The name is the tree\'s own root row, so the header restated the first row of the surface. Same band geometry as GitPanel.'],
  ['BacklogPanel.tsx', 'Owns its chrome row deliberately (owner, 2026-09-05): the search field, the count, the filter glyph and the actions share ONE band, in place of a PanelHeader reading "Backlog · N". The word was already on screen — the pane tab this panel lives in is labelled "Backlog" — so the header cost 36px of a narrow pane to say nothing new. Same band geometry as GitPanel.'],
  ['GitPanel.tsx', 'Owns its chrome row deliberately (owner, 2026-09-04): the icon-only view Tabs strip AND the sync affordances share ONE band, in place of a PanelHeader identity row above them. Both halves of that title were already on screen — the pane tab this panel lives in is labelled "Git", and "Up to date" is what the absence of the Pull/Push buttons means — so the header cost 36px of a narrow pane to say nothing new. The surface owns richer chrome than PanelHeader allows.'],
  ['GitGraphView.tsx', 'Graph sub-view rendered inside GitPanel; the parent panel owns the operational chrome.'],
  ['GitConflictResolverPanel.tsx', 'Rebuild scheduled in the app-wide audit plan (Stage 7).'],
  ['MemoryGraphPanel.tsx', 'Graph canvas surface; rebuild scheduled in the app-wide audit plan.'],
  ['ComposerAttachmentStrip.tsx', 'The attachment strip of the chat composer (MC-2148 launch surface), rendered inside AgentChatView: a row of chips above the field, not a panel, so it carries no PanelHeader.'],
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
