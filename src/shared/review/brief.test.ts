import assert from 'node:assert/strict'
import { validateReviewChangeSet, type ReviewChangeSet } from './changeset'
import {
  checkBriefMatchesChangeSet,
  validateReviewBrief,
  type ReviewBrief,
} from './brief'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

function validChangeSet(): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs-1',
    source: { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' },
    title: 'Invitations',
    baseRef: 'main',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        binary: false,
        additions: 5,
        deletions: 1,
        hunks: [{ oldStart: 1, oldLines: 8, newStart: 1, newLines: 10, lines: [{ kind: 'add', text: 'x' }] }],
      },
      {
        path: 'src/b.ts',
        status: 'added',
        binary: false,
        additions: 5,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5, lines: [{ kind: 'add', text: 'y' }] }],
      },
      { path: 'logo.png', status: 'added', binary: true, additions: 0, deletions: 0, hunks: [] },
    ],
    stats: { files: 3, additions: 10, deletions: 1 },
    fetchedAt: '2026-07-17T10:00:00Z',
  }
}

function validBrief(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs-1',
    generatedAt: '2026-07-17T10:05:00Z',
    overview: {
      intent: 'Add invitations',
      blastRadius: 'Touches the a and b modules',
      readingGuide: 'Data model first, then wiring',
      complexity: 'medium',
    },
    steps: [
      {
        id: 'step-a',
        order: 0,
        title: 'The data model',
        narrative: 'a.ts gains the model',
        files: [{ path: 'src/a.ts', why: 'introduces the Invitation type', readingNote: 'read-closely' }],
        annotations: [
          {
            id: 'ann-1',
            path: 'src/a.ts',
            anchor: { side: 'new', startLine: 2, endLine: 4 },
            kind: 'explain',
            title: 'New Invitation model',
            summary: 'Defines the shape stored per invite.',
            hoverTip: 'The Invitation type introduced here.',
          },
        ],
      },
      {
        id: 'step-b',
        order: 1,
        title: 'The wiring',
        narrative: 'b.ts consumes it',
        files: [{ path: 'src/b.ts', why: 'wires the model into the flow' }],
        annotations: [],
      },
    ],
    knowledgeRefs: [{ note: 'auth-tokens', reason: 'invitation tokens reuse the auth token store' }],
    coverage: { assignedPaths: ['src/a.ts', 'src/b.ts'], unassignedPaths: [] },
  }
}

function cloneBrief(): ReviewBrief {
  return JSON.parse(JSON.stringify(validBrief())) as ReviewBrief
}

function briefErrors(mutate: (b: ReviewBrief) => void): string[] {
  const brief = cloneBrief()
  mutate(brief)
  const result = validateReviewBrief(brief)
  return result.ok ? [] : result.errors
}

function matchErrors(mutate: (b: ReviewBrief) => void): string[] {
  const brief = cloneBrief()
  mutate(brief)
  const cs = validateReviewChangeSet(validChangeSet())
  assert.ok(cs.ok)
  const result = checkBriefMatchesChangeSet(brief, cs.value)
  return result.ok ? [] : result.errors
}

run('a valid brief round-trips and matches its changeset', () => {
  const brief = validateReviewBrief(validBrief())
  assert.ok(brief.ok, brief.ok ? '' : brief.errors.join('\n'))
  const cs = validateReviewChangeSet(validChangeSet())
  assert.ok(cs.ok)
  assert.ok(checkBriefMatchesChangeSet((brief as { value: ReviewBrief }).value, cs.value).ok)
})

// --- standalone shape rules ---

run('a too-long hoverTip is rejected', () => {
  const errors = briefErrors((b) => (b.steps[0].annotations[0].hoverTip = 'x'.repeat(201)))
  assert.match(errors.join('\n'), /hoverTip must be 200 characters or fewer/)
})

run('an empty files[].why is rejected', () => {
  const errors = briefErrors((b) => (b.steps[0].files[0].why = '   '))
  assert.match(errors.join('\n'), /files\[0\]\.why must be a non-empty string/)
})

run('a smuggled severity-like annotation kind is rejected, naming it', () => {
  const errors = briefErrors((b) => ((b.steps[0].annotations[0] as { kind: string }).kind = 'critical'))
  assert.match(errors.join('\n'), /annotations\[0\]\.kind has unknown value "critical"/)
})

run('an unknown overview complexity is rejected', () => {
  const errors = briefErrors((b) => ((b.overview as { complexity: string }).complexity = 'severe'))
  assert.match(errors.join('\n'), /overview\.complexity has unknown value "severe"/)
})

run('duplicate step ids are rejected', () => {
  const errors = briefErrors((b) => (b.steps[1].id = 'step-a'))
  assert.match(errors.join('\n'), /steps\[1\]\.id duplicates an earlier step id "step-a"/)
})

// --- change map rules ---

function withChangeMap(): ReviewBrief {
  const brief = cloneBrief()
  brief.changeMap = {
    nodes: [
      { id: 'n1', label: 'Invitation', stepId: 'step-a', kind: 'data' },
      { id: 'n2', label: 'Flow', stepId: 'step-b', kind: 'ui' },
    ],
    edges: [{ from: 'n1', to: 'n2', label: 'used by' }],
  }
  return brief
}

run('a valid change map round-trips', () => {
  assert.ok(validateReviewBrief(withChangeMap()).ok)
})

run('a change-map node referencing an unknown step is rejected', () => {
  const brief = withChangeMap()
  brief.changeMap!.nodes[0].stepId = 'step-z'
  const result = validateReviewBrief(brief)
  assert.ok(!result.ok)
  assert.match(result.errors.join('\n'), /changeMap\.nodes\[0\]\.stepId "step-z" does not reference a brief step/)
})

run('a change-map edge referencing an unknown node is rejected', () => {
  const brief = withChangeMap()
  brief.changeMap!.edges[0].to = 'n9'
  const result = validateReviewBrief(brief)
  assert.ok(!result.ok)
  assert.match(result.errors.join('\n'), /changeMap\.edges\[0\]\.to "n9" does not reference a change-map node/)
})

run('duplicate change-map node ids are rejected', () => {
  const brief = withChangeMap()
  brief.changeMap!.nodes[1].id = 'n1'
  const result = validateReviewBrief(brief)
  assert.ok(!result.ok)
  assert.match(result.errors.join('\n'), /changeMap\.nodes\[1\]\.id duplicates an earlier node id "n1"/)
})

run('a change map over the node cap is rejected', () => {
  const brief = withChangeMap()
  brief.changeMap!.nodes = Array.from({ length: 15 }, (_unused, i) => ({
    id: `n${i}`,
    label: `Node ${i}`,
    stepId: 'step-a',
    kind: 'other' as const,
  }))
  brief.changeMap!.edges = []
  const result = validateReviewBrief(brief)
  assert.ok(!result.ok)
  assert.match(result.errors.join('\n'), /changeMap\.nodes must have 14 nodes or fewer; got 15/)
})

// --- checkBriefMatchesChangeSet ---

run('id mismatch between brief and changeset is caught', () => {
  const errors = matchErrors((b) => (b.changeSetId = 'cs-other'))
  assert.match(errors.join('\n'), /changeSetId "cs-other" does not match changeset\.id "cs-1"/)
})

run('an out-of-range anchor is caught', () => {
  const errors = matchErrors((b) => (b.steps[0].annotations[0].anchor.endLine = 99))
  assert.match(errors.join('\n'), /anchor lines 2-99 fall outside the new-side extent \(1-10\)/)
})

run('a path a step references but the changeset lacks is caught', () => {
  const errors = matchErrors((b) => (b.steps[0].files[0].path = 'src/ghost.ts'))
  assert.match(errors.join('\n'), /files\[0\]\.path "src\/ghost\.ts" is not in the changeset/)
})

run('an unassigned changed file is caught (no silent drop)', () => {
  const errors = matchErrors((b) => {
    b.steps[1].files = []
    b.coverage.assignedPaths = ['src/a.ts']
  })
  assert.match(errors.join('\n'), /changed file "src\/b\.ts" is neither assigned to a step nor listed in coverage\.unassignedPaths/)
})

run('a double-assigned path is caught', () => {
  const errors = matchErrors((b) => {
    b.steps[1].files.push({ path: 'src/a.ts', why: 'also touched here' })
    b.coverage.assignedPaths = ['src/a.ts', 'src/b.ts']
  })
  assert.match(errors.join('\n'), /path "src\/a\.ts" is assigned to 2 steps/)
})

run('a coverage list out of sync with the steps is caught', () => {
  const errors = matchErrors((b) => (b.coverage.assignedPaths = ['src/a.ts']))
  assert.match(errors.join('\n'), /coverage\.assignedPaths is missing assigned path "src\/b\.ts"/)
})

run('an unassignedPaths entry that is actually assigned is caught', () => {
  const errors = matchErrors((b) => (b.coverage.unassignedPaths = ['src/a.ts']))
  assert.match(errors.join('\n'), /"src\/a\.ts" is both assigned and listed in unassignedPaths/)
})

run('a binary file needs no step assignment', () => {
  // logo.png is never assigned and never in unassignedPaths — that is fine.
  const cs = validateReviewChangeSet(validChangeSet())
  assert.ok(cs.ok)
  assert.ok(checkBriefMatchesChangeSet(validBrief(), cs.value).ok)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('brief.test.ts: ok')
}

main()
