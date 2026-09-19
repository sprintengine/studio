import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetWorkspaceSidecar,
  resolveWorkspaceSidecar,
  workspaceSidecarPath,
  workspaceSidecarRoot,
} from './workspace-sidecar'

const roots: string[] = []

function workspace(...sidecarDirNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-'))
  roots.push(root)
  for (const name of sidecarDirNames) mkdirSync(join(root, name), { recursive: true })
  forgetWorkspaceSidecar(root)
  return root
}

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('a workspace with neither directory gets the new name', () => {
  const root = workspace()
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine')
  assert.equal(workspaceSidecarRoot(root), join(root, '.sprintengine'))
})

run('a workspace that already has the new directory keeps it', () => {
  const root = workspace('.sprintengine')
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine')
})

// The fallback that keeps every workspace created before the rename working:
// its worktrees, backlog cache and automation state are all under the old name
// and nothing moves them.
run('a workspace that only has the old directory keeps reading the old one', () => {
  const root = workspace('.multi-code')
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.multi-code')
  assert.equal(workspaceSidecarRoot(root), join(root, '.multi-code'))
  assert.equal(
    workspaceSidecarPath(root, 'automations', 'alpha', 'run.json'),
    join(root, '.multi-code', 'automations', 'alpha', 'run.json'),
  )
})

// Both can exist when a workspace was opened by a build from either side of the
// rename. The new one wins and the old one is untouched — a directory nobody
// reads is recoverable, a merge that drops a run.yaml is not.
run('when both directories exist the new one wins and the old one survives', () => {
  const root = workspace('.multi-code', '.sprintengine')
  writeFileSync(join(root, '.multi-code', 'marker'), 'kept', 'utf8')
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine')
  assert.equal(resolveWorkspaceSidecar(root).root, join(root, '.sprintengine'))
  assert.doesNotThrow(
    () => rmSync(join(root, '.multi-code', 'marker')),
    'the old directory must not be moved or removed',
  )
})

run('a file named like a sidecar is not one', () => {
  const root = workspace('.multi-code')
  writeFileSync(join(root, '.sprintengine'), 'not a directory', 'utf8')
  forgetWorkspaceSidecar(root)
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.multi-code')
})

// Path building runs long before a workspace is chosen, and a resolver that
// touched the filesystem for an empty root would answer from the process cwd.
run('a root that is not an absolute path answers with the new name and touches nothing', () => {
  for (const root of ['', '   ', 'relative/workspace', './here']) {
    assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine', `${JSON.stringify(root)}`)
  }
})

run('a trailing separator resolves to the same cached answer', () => {
  const root = workspace('.multi-code')
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.multi-code')
  assert.equal(resolveWorkspaceSidecar(`${root}/`).dirName, '.multi-code')
})

run('forgetting a workspace re-reads the disk', () => {
  const root = workspace()
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine')
  rmSync(join(root, '.sprintengine'), { recursive: true, force: true })
  mkdirSync(join(root, '.multi-code'), { recursive: true })
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.sprintengine', 'the answer is memoized until dropped')
  forgetWorkspaceSidecar(root)
  assert.equal(resolveWorkspaceSidecar(root).dirName, '.multi-code')
})

function main(): void {
  try {
    for (const test of tests) {
      try {
        test.body()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        console.error(`not ok - ${test.name}`)
        throw error
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
  console.log('main/workspace-sidecar.test.ts: ok')
}

main()
