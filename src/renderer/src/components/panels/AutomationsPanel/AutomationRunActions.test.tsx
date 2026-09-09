import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { AutomationRunActions } from './AutomationRunActions'
import type { AutomationRun } from '../../../../../shared/automations/contracts'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// A minimal completed run with no actionable affordances; each test layers on
// only the field under test so the gate being asserted is unambiguous.
function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    status: 'completed',
    dueAt: '2026-06-28T00:00:00Z',
    startedAt: '2026-06-28T00:00:01Z',
    completedAt: '2026-06-28T00:00:09Z',
    ...overrides,
  }
}

const noop = () => {}
function markup(run: AutomationRun, onViewReport?: (run: AutomationRun) => void): string {
  return renderToStaticMarkup(
    <AutomationRunActions run={run} onOpenAgent={noop} onViewReport={onViewReport} onFinalize={noop} finalizing={false} />,
  )
}

// Recursively find the rendered "View report" button and fire its onClick, so the
// callback wiring is asserted as behaviour rather than by source inspection.
function clickViewReport(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false
  const node = element as { props?: { onClick?: () => void; children?: unknown } }
  const children = node.props?.children
  const text = Array.isArray(children) ? children.join('') : children
  if (typeof node.props?.onClick === 'function' && text === 'View report') {
    node.props.onClick()
    return true
  }
  const kids = Array.isArray(children) ? children : [children]
  return kids.some((child) => clickViewReport(child))
}

// ---- Acceptance 1: honest "View report" affordance --------------------------

run('renders "View report" when the run has reportPaths and a handler is wired', () => {
  assert.match(markup(makeRun({ reportPaths: ['reports/run-1.md'] }), noop), /View report/)
})

run('omits "View report" when the run produced no report (empty reportPaths, no summary match)', () => {
  const m = markup(makeRun({ reportPaths: [], summary: 'Nothing to see here.' }), noop)
  assert.ok(!m.includes('View report'), 'no fake affordance for a report-less run')
})

run('omits "View report" when no onViewReport handler is wired, even with a report present', () => {
  // The handler is undefined on surfaces that do not host the viewer; the
  // affordance must not appear as a dead button.
  const m = markup(makeRun({ reportPaths: ['reports/run-1.md'] }), undefined)
  assert.ok(!m.includes('View report'), 'no affordance without a handler')
})

run('lights up "View report" for a historical run via the summary scan (no reportPaths)', () => {
  const m = markup(makeRun({ summary: 'Wrote reports/audit.md with findings.' }), noop)
  assert.match(m, /View report/, 'a reports/…md path scanned from the summary is honoured')
})

// ---- Early-return gate: a report-only run still renders the row -------------

run('a report-only run (no agent/workspace/PR, not running) still renders the row with View report', () => {
  // Before the gate included report presence this run was actionable-empty and
  // returned null, hiding its report. It must now render.
  const m = markup(makeRun({ reportPaths: ['reports/run-1.md'] }), noop)
  assert.notEqual(m, '', 'the row is rendered, not early-returned to null')
  assert.match(m, /View report/)
})

run('a run with nothing actionable and no report renders nothing', () => {
  assert.equal(markup(makeRun({ summary: 'plain text' }), noop), '', 'early-returns null when truly empty')
})

// ---- The pull request link (epic pull-request-marks, decisions 1-3) ---------

run('a run’s pull request is the words, with no state mark beside them', () => {
  // A shape is a claim about state. `AutomationRun` carries a URL and nothing
  // else — no state, no reading, nothing watching it — so a mark here would
  // draw the OPEN fork for a pull request that merged weeks ago. Nothing is
  // drawn unless the app definitely knows (decision 3).
  const m = markup(makeRun({ pullRequestUrl: 'https://github.com/acme/app/pull/12' }), noop)
  assert.match(m, /Pull request/, 'the link keeps its words')
  assert.match(m, /href="https:\/\/github\.com\/acme\/app\/pull\/12"/, 'and opens the pull request')
  assert.ok(!m.includes('<svg'), 'and draws no glyph at all, which is what a state mark would be')
})

// ---- Click wiring -----------------------------------------------------------

run('clicking "View report" invokes onViewReport with the run', () => {
  const run = makeRun({ reportPaths: ['reports/run-1.md'] })
  let received: AutomationRun | null = null
  const tree = AutomationRunActions({
    run,
    onOpenAgent: noop,
    onViewReport: (r) => { received = r },
    onFinalize: noop,
    finalizing: false,
  })
  assert.ok(clickViewReport(tree), 'the View report button is present in the tree')
  assert.equal(received, run, 'the clicked run is passed straight to onViewReport')
})

if (failures > 0) {
  console.error(`AutomationRunActions.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('AutomationRunActions.test.tsx: ok')
