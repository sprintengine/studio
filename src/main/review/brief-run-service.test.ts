import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewBrief } from '../../shared/review'
import { readBriefFromDir, writeBriefAtomic } from './brief-run-service'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const tempDirs: string[] = []
function makeReviewDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-run-'))
  tempDirs.push(dir)
  return dir
}

function validBrief(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_fixture',
    headSha: 'abc123def456',
    generatedAt: '2026-07-18T00:00:00Z',
    overview: {
      intent: 'Add a next counter to the store and a view that reads it.',
      blastRadius: 'Touches the store shape and one new view component.',
      readingGuide: 'Read the store first, then the view that consumes it.',
      complexity: 'low',
    },
    steps: [
      {
        id: 'step-store',
        order: 0,
        title: 'Store foundation',
        narrative: 'The store gains a next field; the view later reads it.',
        files: [{ path: 'src/store.ts', why: 'introduces the next field', readingNote: 'read-closely' }],
        annotations: [
          {
            id: 'ann-1',
            path: 'src/store.ts',
            anchor: { side: 'new', startLine: 1, endLine: 2 },
            kind: 'explain',
            title: 'New field',
            summary: 'The store now carries a next counter.',
            hoverTip: 'This is where the counter enters the store shape.',
          },
        ],
      },
    ],
    knowledgeRefs: [{ note: 'multicode/review-workspace', reason: 'the store shape is documented there' }],
    coverage: { assignedPaths: ['src/store.ts'], unassignedPaths: [] },
  }
}

run('a written brief reads back verbatim', async () => {
  const dir = makeReviewDir()
  const brief = validBrief()
  await writeBriefAtomic(dir, brief)

  assert.ok(existsSync(join(dir, 'brief.json')))
  assert.deepEqual(await readBriefFromDir(dir), brief)
  // Written whole, not left half-formed: the temp file never survives a success.
  assert.deepEqual(readdirSync(dir), ['brief.json'])
})

run('rewriting replaces the previous walkthrough', async () => {
  const dir = makeReviewDir()
  await writeBriefAtomic(dir, validBrief())
  const next = validBrief()
  next.overview.intent = 'A second pass over the same change.'
  await writeBriefAtomic(dir, next)

  assert.equal((await readBriefFromDir(dir))?.overview.intent, 'A second pass over the same change.')
  assert.deepEqual(readdirSync(dir), ['brief.json'])
})

run('a missing, malformed, or invalid brief reads as "no usable walkthrough"', async () => {
  const dir = makeReviewDir()
  assert.equal(await readBriefFromDir(dir), null, 'no brief written yet')

  writeFileSync(join(dir, 'brief.json'), '{ not json', 'utf-8')
  assert.equal(await readBriefFromDir(dir), null, 'unparseable brief')

  // A severity-like annotation kind is rejected by the shape validator — the
  // no-verdicts firewall — so a brief carrying one is not a usable walkthrough.
  const verdict = validBrief() as unknown as { steps: Array<{ annotations: Array<{ kind: string }> }> }
  verdict.steps[0].annotations[0].kind = 'critical'
  writeFileSync(join(dir, 'brief.json'), JSON.stringify(verdict), 'utf-8')
  assert.equal(await readBriefFromDir(dir), null, 'brief carrying a verdict')
})

// The tests run from the repo root (npm run), so resolve repo files from cwd.
const skillPath = join(process.cwd(), 'resources', 'skills', 'review-guide', 'SKILL.md')

run('the skill carries the schema doc verbatim', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'review-brief-schema.md'), 'utf-8')
  const skill = readFileSync(skillPath, 'utf-8')
  // The skill is the guide's ONLY instruction layer, so its embedded schema is
  // what every guide actually builds against. This equality is the drift guard
  // against the canonical doc.
  assert.equal(sharedBlock(skill, 'schema-doc'), doc, 'embedded schema doc is verbatim (drift guard)')
})

run('the skill states the no-judgment rule and delivers through the review tools', () => {
  const skill = readFileSync(skillPath, 'utf-8')
  assert.ok(/never judge/i.test(skill), 'the skill states the no-judgment rule')
  assert.ok(/narrator/i.test(skill), 'the skill frames the guide as a narrator')
  for (const tool of ['review_get_changeset', 'review_get_brief', 'review_submit_brief']) {
    assert.ok(skill.includes(tool), `the skill names ${tool}`)
  }
  // The retired companion transport asked for the brief as a JSON reply. The
  // skill delivers through the tool instead, and must not carry that contract.
  assert.ok(
    !skill.includes('Reply with ONLY the ReviewBrief JSON object'),
    'no companion-era reply contract in the skill'
  )
})

// Pull one `<!-- shared:NAME -->` block out of the skill. The blocks are the
// anchors the drift guard reads; a missing or emptied one is a failure, never a
// silently empty comparison.
function sharedBlock(skillText: string, name: string): string {
  const open = `<!-- shared:${name} -->\n`
  const close = `\n<!-- /shared:${name} -->`
  const start = skillText.indexOf(open)
  const end = start < 0 ? -1 : skillText.indexOf(close, start + open.length)
  assert.ok(start >= 0 && end >= 0, `the skill carries a "${name}" block`)
  const body = skillText.slice(start + open.length, end)
  assert.ok(body.trim().length > 0, `the skill's "${name}" block carries text`)
  return body
}

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  if (failed) process.exit(1)
  console.log('brief-run-service.test.ts: ok')
}

void main()
