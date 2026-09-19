import assert from 'node:assert/strict'
import {
  LEGACY_SIDECAR_DIR_NAME,
  SIDECAR_DIR_NAME,
  SIDECAR_DIR_NAMES,
  forgetSidecarDirName,
  knownSidecarDirName,
  rememberSidecarDirName,
  setUnknownSidecarDirNameResolver,
  sidecarCandidates,
  sidecarFor,
  sidecarPath,
  sidecarRelativePath,
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
    sidecarPath(sidecarFor(WORKSPACE), 'automations', 'team', 'run.json'),
    `${WORKSPACE}/.sprintengine/automations/team/run.json`,
  )
  assert.equal(
    sidecarPath(sidecarFor(WINDOWS_WORKSPACE), 'automations', 'team', 'run.json'),
    `${WINDOWS_WORKSPACE}\\.sprintengine\\automations\\team\\run.json`,
  )
  assert.equal(sidecarPath(sidecarFor(WORKSPACE)), `${WORKSPACE}/.sprintengine`)
})

run('a relative sidecar path is POSIX under either name', () => {
  assert.equal(sidecarRelativePath(SIDECAR_DIR_NAME, 'backlog', 'config.json'), '.sprintengine/backlog/config.json')
  assert.equal(
    sidecarRelativePath(LEGACY_SIDECAR_DIR_NAME, 'backlog', 'config.json'),
    '.multi-code/backlog/config.json',
  )
  assert.equal(sidecarRelativePath(SIDECAR_DIR_NAME), '.sprintengine')
})

// The registry is how one process's answer reaches every path builder in it,
// including the ones that cannot look at a disk.
run('a root nobody has resolved reads as the current name', () => {
  forgetSidecarDirName()
  assert.equal(knownSidecarDirName(WORKSPACE), SIDECAR_DIR_NAME)
  assert.equal(sidecarFor(WORKSPACE).dirName, SIDECAR_DIR_NAME)
})

run('a recorded root is read back under either spelling of its path', () => {
  forgetSidecarDirName()
  rememberSidecarDirName(WORKSPACE, LEGACY_SIDECAR_DIR_NAME)
  assert.equal(knownSidecarDirName(WORKSPACE), LEGACY_SIDECAR_DIR_NAME)
  assert.equal(knownSidecarDirName(`${WORKSPACE}/`), LEGACY_SIDECAR_DIR_NAME)
  assert.equal(sidecarFor(WORKSPACE).root, `${WORKSPACE}/.multi-code`)
  forgetSidecarDirName(WORKSPACE)
  assert.equal(knownSidecarDirName(WORKSPACE), SIDECAR_DIR_NAME)
})

// The main process installs a disk lookup here, so a path built for a workspace
// nothing has resolved yet still lands in that workspace's own sidecar instead
// of creating a second one beside it.
run('an unresolved root falls through to the installed resolver', () => {
  forgetSidecarDirName()
  const asked: string[] = []
  setUnknownSidecarDirNameResolver((root) => {
    asked.push(root)
    return LEGACY_SIDECAR_DIR_NAME
  })
  try {
    assert.equal(knownSidecarDirName(WORKSPACE), LEGACY_SIDECAR_DIR_NAME)
    assert.deepEqual(asked, [WORKSPACE])
    // A recorded answer wins over it, so installing one costs nothing per call.
    rememberSidecarDirName(WORKSPACE, SIDECAR_DIR_NAME)
    assert.equal(knownSidecarDirName(WORKSPACE), SIDECAR_DIR_NAME)
    assert.equal(asked.length, 1)
  } finally {
    setUnknownSidecarDirNameResolver(null)
    forgetSidecarDirName()
  }
})

// The order is the part the two processes must not disagree on: the main process
// stats these in turn, the renderer asks over IPC in the same turn.
run('the candidates are the current name first, then the legacy one', () => {
  assert.deepEqual(
    sidecarCandidates(WORKSPACE).map((candidate) => [candidate.dirName, candidate.root]),
    [
      [SIDECAR_DIR_NAME, `${WORKSPACE}/.sprintengine`],
      [LEGACY_SIDECAR_DIR_NAME, `${WORKSPACE}/.multi-code`],
    ],
  )
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
