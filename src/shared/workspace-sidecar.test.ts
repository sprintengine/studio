import assert from 'node:assert/strict'
import {
  LEGACY_SIDECAR_DIR_NAME,
  SIDECAR_DIR_NAME,
  SIDECAR_DIR_NAMES,
  SIDECAR_DIR_PATTERN_SOURCE,
  isSidecarDirName,
  sidecarDirNameOfPath,
  sidecarFor,
  sidecarPath,
  sidecarRelativePath,
  withoutSidecarPrefix,
} from './workspace-sidecar'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const WORKSPACE = '/Users/dev/projects/studio'
const WINDOWS_WORKSPACE = 'C:\\Users\\dev\\projects\\studio'

run('the preferred name is the new one and the legacy name is still recognised', () => {
  assert.equal(SIDECAR_DIR_NAME, '.sprintengine')
  assert.equal(LEGACY_SIDECAR_DIR_NAME, '.multi-code')
  assert.deepEqual([...SIDECAR_DIR_NAMES], ['.sprintengine', '.multi-code'])
  assert.ok(isSidecarDirName('.sprintengine'))
  assert.ok(isSidecarDirName('.multi-code'))
})

run('a name that is neither is not a sidecar', () => {
  for (const segment of ['.sprintengine-old', 'sprintengine', '.multicode', '.multi_code', '', 'src']) {
    assert.equal(isSidecarDirName(segment), false, `${JSON.stringify(segment)} must not read as a sidecar`)
  }
})

run('a sidecar defaults to the new name and takes the old one when asked', () => {
  assert.equal(sidecarFor(WORKSPACE).dirName, SIDECAR_DIR_NAME)
  assert.equal(sidecarFor(WORKSPACE).root, `${WORKSPACE}/.sprintengine`)
  assert.equal(sidecarFor(WORKSPACE, LEGACY_SIDECAR_DIR_NAME).root, `${WORKSPACE}/.multi-code`)
})

// Every stored path this app writes is workspace-relative and POSIX, on both
// platforms, so the absolute form is the only one that may take a backslash.
run('an absolute path keeps the separator its workspace root is written with', () => {
  assert.equal(
    sidecarPath(sidecarFor(WORKSPACE), 'sprintengine', 'team', 'run.yaml'),
    `${WORKSPACE}/.sprintengine/sprintengine/team/run.yaml`,
  )
  assert.equal(
    sidecarPath(sidecarFor(WINDOWS_WORKSPACE), 'sprintengine', 'team', 'run.yaml'),
    `${WINDOWS_WORKSPACE}\\.sprintengine\\sprintengine\\team\\run.yaml`,
  )
  assert.equal(sidecarPath(sidecarFor(WORKSPACE)), `${WORKSPACE}/.sprintengine`)
})

run('a relative sidecar path is POSIX under either name', () => {
  assert.equal(sidecarRelativePath(SIDECAR_DIR_NAME, 'backlog', 'config.json'), '.sprintengine/backlog/config.json')
  assert.equal(sidecarRelativePath(LEGACY_SIDECAR_DIR_NAME, 'backlog', 'config.json'), '.multi-code/backlog/config.json')
  assert.equal(sidecarRelativePath(SIDECAR_DIR_NAME), '.sprintengine')
})

// The reading half of the fallback: a path written by any version of the app,
// on either platform, has to be recognised as a sidecar path.
run('a path is recognised under either name and either separator', () => {
  assert.equal(sidecarDirNameOfPath(`${WORKSPACE}/.sprintengine/sprintengine/t/run.yaml`), '.sprintengine')
  assert.equal(sidecarDirNameOfPath(`${WORKSPACE}/.multi-code/sprintengine/t/run.yaml`), '.multi-code')
  assert.equal(sidecarDirNameOfPath('C:\\repo\\.multi-code\\browser'), '.multi-code')
  assert.equal(sidecarDirNameOfPath('.sprintengine/backlog/config.json'), '.sprintengine')
  assert.equal(sidecarDirNameOfPath(`${WORKSPACE}/src/main/index.ts`), null)
  // A directory that merely starts with the name is a different directory.
  assert.equal(sidecarDirNameOfPath(`${WORKSPACE}/.sprintengine-backup/x`), null)
})

run('the pattern fragment matches both names and nothing adjacent', () => {
  const pattern = new RegExp(`^${SIDECAR_DIR_PATTERN_SOURCE}/sprintengine/([^/]+)/run\\.yaml$`, 'u')
  assert.equal(pattern.exec('.sprintengine/sprintengine/alpha/run.yaml')?.[1], 'alpha')
  assert.equal(pattern.exec('.multi-code/sprintengine/alpha/run.yaml')?.[1], 'alpha')
  assert.equal(pattern.test('xsprintengine/sprintengine/alpha/run.yaml'), false)
  // The dot is escaped, so it matches a literal dot rather than any character.
  assert.equal(pattern.test('Xsprintengine/sprintengine/alpha/run.yaml'), false)
})

run('the sidecar prefix comes off under either name, and only when it is there', () => {
  assert.deepEqual(withoutSidecarPrefix(['.sprintengine', 'sprintengine', 't', 'plan.md']), ['sprintengine', 't', 'plan.md'])
  assert.deepEqual(withoutSidecarPrefix(['.multi-code', 'sprintengine', 't', 'plan.md']), ['sprintengine', 't', 'plan.md'])
  assert.deepEqual(withoutSidecarPrefix(['.sprintengine']), [])
  assert.equal(withoutSidecarPrefix(['plan.md']), null)
  assert.equal(withoutSidecarPrefix([]), null)
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
  console.log('workspace-sidecar.test.ts: ok')
}

main()
