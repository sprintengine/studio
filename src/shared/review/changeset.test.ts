import assert from 'node:assert/strict'
import { validateReviewChangeSet, type ReviewChangeSet } from './changeset'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

function validChangeSet(): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs-1',
    source: {
      kind: 'pull-request',
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 42,
      url: 'https://github.com/acme/app/pull/42',
    },
    title: 'Add invitations',
    baseRef: 'main',
    headSha: 'deadbeef',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        binary: false,
        additions: 4,
        deletions: 2,
        hunks: [
          {
            oldStart: 1,
            oldLines: 8,
            newStart: 1,
            newLines: 10,
            lines: [{ kind: 'add', text: 'const x = 1' }],
          },
        ],
      },
      { path: 'logo.png', status: 'added', binary: true, additions: 0, deletions: 0, hunks: [] },
    ],
    stats: { files: 2, additions: 4, deletions: 2 },
    fetchedAt: '2026-07-17T10:00:00Z',
  }
}

function clone(value: unknown): ReviewChangeSet {
  return JSON.parse(JSON.stringify(value)) as ReviewChangeSet
}

function errorsFor(mutate: (cs: ReviewChangeSet) => void): string[] {
  const cs = clone(validChangeSet())
  mutate(cs)
  const result = validateReviewChangeSet(cs)
  return result.ok ? [] : result.errors
}

run('a valid changeset round-trips', () => {
  const result = validateReviewChangeSet(validChangeSet())
  assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'))
})

run('a branch source and a patch source both validate', () => {
  const branch = clone(validChangeSet())
  branch.source = { kind: 'branch', repoRoot: '/repo', baseRef: 'main', headRef: 'feature' }
  assert.ok(validateReviewChangeSet(branch).ok)

  const patch = clone(validChangeSet())
  delete (patch as { headSha?: string }).headSha
  patch.source = { kind: 'patch', label: 'pasted.diff' }
  assert.ok(validateReviewChangeSet(patch).ok)
})

run('an unknown schemaVersion is rejected, naming the version', () => {
  const errors = errorsFor((cs) => ((cs as { schemaVersion: number }).schemaVersion = 2))
  assert.match(errors.join('\n'), /schemaVersion must be 1; got 2/)
})

run('an unknown source kind is rejected, naming the value', () => {
  const errors = errorsFor((cs) => ((cs.source as { kind: string }).kind = 'gitlab-mr'))
  assert.match(errors.join('\n'), /source\.kind has unknown value "gitlab-mr"/)
})

run('an unknown PR provider is rejected, never silently passed', () => {
  const errors = errorsFor((cs) => ((cs.source as { provider: string }).provider = 'bitbucket'))
  assert.match(errors.join('\n'), /source\.provider has unknown value "bitbucket"/)
})

run('an unknown file status is rejected', () => {
  const errors = errorsFor((cs) => ((cs.files[0] as { status: string }).status = 'copied'))
  assert.match(errors.join('\n'), /files\[0\]\.status has unknown value "copied"/)
})

run('a renamed file without oldPath is rejected', () => {
  const errors = errorsFor((cs) => {
    cs.files[0].status = 'renamed'
    delete cs.files[0].oldPath
  })
  assert.match(errors.join('\n'), /files\[0\]\.oldPath is required when status is 'renamed'/)
})

run('a binary file carrying hunks is rejected', () => {
  const errors = errorsFor((cs) => {
    cs.files[1].hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }]
  })
  assert.match(errors.join('\n'), /files\[1\]\.hunks must be empty when binary is true/)
})

run('an unknown hunk line kind is rejected', () => {
  const errors = errorsFor((cs) => ((cs.files[0].hunks[0].lines[0] as { kind: string }).kind = 'meta'))
  assert.match(errors.join('\n'), /files\[0\]\.hunks\[0\]\.lines\[0\]\.kind has unknown value "meta"/)
})

run('a non-ISO fetchedAt is rejected', () => {
  const errors = errorsFor((cs) => ((cs as { fetchedAt: string }).fetchedAt = 'yesterday'))
  assert.match(errors.join('\n'), /fetchedAt must be an ISO-8601 timestamp/)
})

run('unknown extra keys are tolerated for forward compat', () => {
  const cs = clone(validChangeSet()) as ReviewChangeSet & { futureField?: unknown }
  cs.futureField = { anything: true }
  assert.ok(validateReviewChangeSet(cs).ok)
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
  console.log('changeset.test.ts: ok')
}

main()
