import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { ReviewWalkthroughHarness } from './ReviewWalkthroughHarness'
import { ReviewWalkthrough } from './ReviewWalkthrough'
import { reviewFixture, fixtureBrief, fixtureChangeSet } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// The regression net: the harness renders the whole surface from a fixture triple
// with zero IPC (no store, no window.api). renderToStaticMarkup would throw if any
// child reached for a runtime dependency, so a clean render proves the projection
// is pure. Monaco stays behind Suspense and shows its fallback here.
const html = renderToStaticMarkup(<ReviewWalkthroughHarness />)

run('renders the top bar identity, stats, and complexity as a word', () => {
  assert.ok(html.includes('Add teammate invitations with roles'))
  // design-tokens-allow: "#482" is a pull-request number in an expected string, not a color literal
  assert.ok(html.includes('acme/web-app #482 · 4f2c19a'))
  assert.ok(html.includes('+19'))
  assert.ok(html.includes('−1'))
  // Complexity is a word, never a color.
  assert.ok(html.includes('Complexity'))
  assert.ok(html.includes('high'))
})

run('renders the rail: progress, ordered steps, and the continue target', () => {
  assert.ok(html.includes('Walkthrough'))
  assert.ok(html.includes('1 of 4 files read'))
  assert.ok(html.includes('The invitation data model'))
  assert.ok(html.includes('Invitation API + email delivery'))
  assert.ok(html.includes('Tests &amp; fixtures'))
  assert.ok(html.includes('2 files · 1 note'))
  assert.ok(html.includes('Continue with step 1'))
})

run('renders the active step narrative and every file card with its why-line', () => {
  assert.ok(html.includes('The agent introduced an Invitation record'))
  assert.ok(html.includes('prisma/schema.prisma'))
  assert.ok(html.includes('new Invitation + role types'))
  // mechanical-skim appends the safe-to-skim reassurance to the why-line.
  assert.ok(html.includes('mechanical mirror, safe to skim'))
})

run('renders the read toggle in both states from the fixture read set', () => {
  // schema.prisma is read (aria-pressed true), migration is not (false).
  assert.ok(html.includes('aria-pressed="true"'))
  assert.ok(html.includes('aria-pressed="false"'))
  assert.ok(html.includes('>Read<'))
  assert.ok(html.includes('>Mark read<'))
})

run('renders the side panel notes for the active step', () => {
  assert.ok(html.includes('In this step'))
  assert.ok(html.includes('New Invitation model'))
  assert.ok(html.includes('Jump to lines'))
  assert.ok(html.includes('L34–42'))
})

run('renders the Overview pane with labeled paragraphs and grounded knowledge', () => {
  const overview = renderToStaticMarkup(
    <ReviewWalkthrough
      changeset={fixtureChangeSet}
      brief={fixtureBrief}
      readFiles={new Set()}
      diffView="side-by-side"
      activePaneId="overview"
      monacoTheme="vs-dark"
      rerunning={false}
      onSetActivePane={() => {}}
      onSetDiffView={() => {}}
      onToggleRead={() => {}}
      onRequestComment={() => {}}
      onAskGuide={() => {}}
      onRerun={() => {}}
    />,
  )
  assert.ok(overview.includes('What this is.'))
  assert.ok(overview.includes('Blast radius.'))
  assert.ok(overview.includes('How it reads.'))
  assert.ok(overview.includes('Grounded in'))
  assert.ok(overview.includes('auth-tokens'))
})

run('surfaces an uncovered-files warning when coverage lists them', () => {
  const briefWithGap = {
    ...fixtureBrief,
    coverage: { assignedPaths: fixtureBrief.coverage.assignedPaths, unassignedPaths: ['src/legacy/untouched.ts'] },
  }
  const overview = renderToStaticMarkup(
    <ReviewWalkthrough
      changeset={fixtureChangeSet}
      brief={briefWithGap}
      readFiles={new Set()}
      diffView="side-by-side"
      activePaneId="overview"
      monacoTheme="vs-dark"
      rerunning={false}
      onSetActivePane={() => {}}
      onSetDiffView={() => {}}
      onToggleRead={() => {}}
      onRequestComment={() => {}}
      onAskGuide={() => {}}
      onRerun={() => {}}
    />,
  )
  assert.ok(overview.includes('Not covered by the walkthrough'))
  assert.ok(overview.includes('src/legacy/untouched.ts'))
})

function renderOverview(brief: typeof fixtureBrief): string {
  return renderToStaticMarkup(
    <ReviewWalkthrough
      changeset={fixtureChangeSet}
      brief={brief}
      readFiles={new Set()}
      diffView="side-by-side"
      activePaneId="overview"
      monacoTheme="vs-dark"
      rerunning={false}
      onSetActivePane={() => {}}
      onSetDiffView={() => {}}
      onToggleRead={() => {}}
      onRequestComment={() => {}}
      onAskGuide={() => {}}
      onRerun={() => {}}
    />,
  )
}

run('renders the change map in the Overview, wired to its steps', () => {
  const overview = renderOverview(fixtureBrief)
  assert.ok(overview.includes('Change map'))
  assert.ok(overview.includes('Invitations API'))
  // Nodes carry their step navigation as keyboard-reachable buttons.
  assert.ok(overview.includes('role="button"'))
  assert.ok(overview.includes('Go to step 2'))
  // deployNote surfaces as the caption.
  assert.ok(overview.includes('Deploy order:'))
})

run('a brief without a change map renders the Overview with no map section', () => {
  const { changeMap: _dropped, ...noMap } = fixtureBrief
  const overview = renderOverview(noMap as typeof fixtureBrief)
  assert.ok(overview.includes('What this is.')) // overview still renders
  assert.ok(!overview.includes('Change map')) // …with no map heading or placeholder
})

run('the layout collapses on narrow panels via a container query, not a window media query', () => {
  // The columns key off THIS panel's width: a `@container` wrapper, the narrow
  // default (rail 210px, no notes column), and the ≥940px expansion (rail 244px +
  // the 276px notes column) — mirroring the mockup's ≤940px breakpoint.
  assert.ok(html.includes('@container'), 'a container context is established')
  assert.ok(html.includes('grid-cols-[210px_minmax(0,1fr)]'), 'narrow default: 2 columns, narrowed rail')
  assert.ok(
    html.includes('@[940px]:grid-cols-[244px_minmax(0,1fr)_276px]'),
    'expands to the full 3-column layout at ≥940px',
  )
  // The right "In this step" column is dropped below the threshold so the diff keeps its width.
  assert.ok(html.includes('hidden min-h-0 @[940px]:block'), 'notes column collapses below 940px')
})

// Reference the fixture so an unused-import refactor can't silently drop it.
assert.ok(reviewFixture.changeset.files.length === 4)

console.log('all ReviewWalkthrough render tests passed')
