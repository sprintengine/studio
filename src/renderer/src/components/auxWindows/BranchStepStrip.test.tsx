import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { BranchStepStrip, BRANCH_STEP_PANEL_ID } from './BranchStepStrip'
import { stripEntriesFrom } from './branchSteps'
import type { BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'

// The step strip's rendered contract (the-diff-an-agent-made /
// changed-files-and-commit-steps). The strip announces `role="tablist"`, so this
// suite exists to make sure it keeps the promises that role makes.

// The note hangs off the kit's Tooltip, whose useLayoutEffect is a no-op under
// the static renderer; React says so once per render.
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
  consoleError(...args)
}

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

function snapshot(patch: Partial<BranchStepsSnapshot> = {}): BranchStepsSnapshot {
  return {
    branch: 'feat',
    baseOid: 'base000',
    scope: 'worktree',
    steps: [
      { hash: 'aaaaaa1', shortHash: 'aaaaaa', subject: 'first', authoredAt: 1, isMerge: false },
      { hash: 'bbbbbb2', shortHash: 'bbbbbb', subject: 'Merge main', authoredAt: 2, isMerge: true },
    ],
    hasUncommitted: true,
    ...patch,
  }
}

function strip(
  snap: BranchStepsSnapshot | null,
  selection: BranchStepSelection = { kind: 'span' },
  note: string | null = null,
): string {
  return renderToStaticMarkup(
    <BranchStepStrip entries={stripEntriesFrom(snap)} selection={selection} onSelect={() => {}} note={note} />,
  )
}

run('a tablist is ONE tab stop: exactly one chip is reachable by Tab', () => {
  const markup = strip(snapshot())
  const zeroes = markup.match(/tabindex="0"/g) ?? []
  const minusOnes = markup.match(/tabindex="-1"/g) ?? []
  assert.equal(zeroes.length, 1, 'roving tabindex, not four tab stops')
  assert.equal(minusOnes.length, 3, 'the other chips are reachable by arrow, not by Tab')
})

run('the tab stop follows the selection rather than staying on the first chip', () => {
  const markup = strip(snapshot(), { kind: 'commit', hash: 'bbbbbb2' })
  // The selected chip is the one carrying both the tab stop and aria-selected.
  const selected = markup.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? ''
  assert.match(selected, /tabindex="0"/, 'focus and selection agree')
})

run('every tab points at the panel it controls, and only one is selected', () => {
  const markup = strip(snapshot())
  const controls = markup.match(new RegExp(`aria-controls="${BRANCH_STEP_PANEL_ID}"`, 'g')) ?? []
  assert.equal(controls.length, 4, 'span + uncommitted + two commits')
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1)
})

run('the strip names itself for a screen reader', () => {
  assert.match(
    strip(snapshot()),
    /role="tablist"[^>]*aria-label="Branch steps"|aria-label="Branch steps"[^>]*role="tablist"/,
  )
})

run('a merge chip is marked, and a commit shows its hash beside its subject', () => {
  const markup = strip(snapshot())
  assert.match(markup, /aaaaaa/, 'short hash')
  assert.match(markup, /Merge main/, 'subject')
  // The merge glyph is the only svg inside a chip when there is no note, and it
  // is the SYSTEM's merged mark now (epic pull-request-marks, decision 12) —
  // this file used to keep a private fork of its own. Matched by the drawing,
  // not by "there is an svg": the node at cy 8.5 is what makes the merged mark
  // the merged one, and a chip that quietly went back to a hand-rolled fork
  // would still have rendered an svg.
  assert.match(markup, /<svg[^>]*viewBox="0 0 16 16"/)
  assert.match(markup, /cy="8\.5"/, 'the merged pull request mark, not a private fork')
  assert.match(markup, /d="M4\.5 5\.2c\.4 2\.2 2 3\.3 5\.4 3\.3"/, 'the branch curving cleanly into main')
  assert.equal((markup.match(/<svg/g) ?? []).length, 1, 'only the merge commit wears a mark')
  // Decorative: the chip's own hash and subject name the commit.
  assert.match(markup, /<svg[^>]*aria-hidden="true"/)
})

run('with no commits there is no strip to operate — and no fake choice', () => {
  const markup = strip(snapshot({ steps: [], hasUncommitted: true }))
  assert.equal(markup, '', 'one entry offers no choice, so no control group is drawn')
})

run('a checkout that cannot claim exactness still says so', () => {
  const markup = strip(
    snapshot({ steps: [], hasUncommitted: false, scope: 'folder' }),
    { kind: 'span' },
    'Working on main. There is no branch to measure.',
  )
  assert.match(markup, /Working on main/, 'the note renders even with no chips')
  assert.doesNotMatch(markup, /role="tablist"/, 'and brings no tablist with it')
})

run('the note is absent when the checkout IS exact', () => {
  assert.doesNotMatch(strip(snapshot(), { kind: 'span' }, null), /Working on/)
})

if (failures > 0) {
  console.error(`BranchStepStrip.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('BranchStepStrip.test.tsx: ok')
