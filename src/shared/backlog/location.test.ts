import assert from 'node:assert/strict'
import { workspaceRelativePath } from '../source-paths'
import {
  backlogAbsolutePath,
  backlogLocationFor,
  backlogLogicalPath,
  backlogRootPath,
  defaultBacklogLocation,
  isDefaultBacklogLocation,
  type BacklogLocation,
} from './scan'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const WORKSPACE = '/Users/dev/projects/studio'
const ELSEWHERE = '/Users/dev/backlogs/studio'

// The whole safety argument for making the root configurable is this: with a
// default location, the logical path is what the old
// `workspaceRelativePath(workspaceRoot, file)` produced, byte for byte. If that
// holds, no stored id, durable link, sprint link or mobile snapshot entry has to
// be migrated when the feature lands. These are the tests that hold it.
run('a default location derives the path the workspace-relative call used to', () => {
  const location = defaultBacklogLocation(WORKSPACE)
  for (const relative of [
    'backlog/unfiled/a-thing.md',
    'backlog/epics/open-platform-strategy.md',
    'backlog/archived/old.md',
    'backlog/deep/nest/of/folders/item.md',
    'backlog/mockups/screen.html',
  ]) {
    const absolute = `${WORKSPACE}/${relative}`
    assert.equal(
      backlogLogicalPath(location, absolute),
      workspaceRelativePath(WORKSPACE, absolute),
      `${relative} must resolve identically under the default location`,
    )
  }
})

run('the logical path is backlog/-prefixed wherever the root actually sits', () => {
  const location: BacklogLocation = { workspaceRoot: WORKSPACE, root: ELSEWHERE }
  assert.equal(backlogLogicalPath(location, `${ELSEWHERE}/epics/thing.md`), 'backlog/epics/thing.md')
  assert.equal(backlogLogicalPath(location, `${ELSEWHERE}/unfiled/a.md`), 'backlog/unfiled/a.md')
  // The identity is the same string it would have had in the checkout, which is
  // what lets a backlog move without rewriting anything that points at it.
  assert.equal(
    backlogLogicalPath(location, `${ELSEWHERE}/epics/thing.md`),
    backlogLogicalPath(defaultBacklogLocation(WORKSPACE), `${WORKSPACE}/backlog/epics/thing.md`),
  )
})

run('a file outside the root has no logical path', () => {
  const location: BacklogLocation = { workspaceRoot: WORKSPACE, root: ELSEWHERE }
  assert.equal(backlogLogicalPath(location, `${WORKSPACE}/backlog/thing.md`), null)
  assert.equal(backlogLogicalPath(location, '/Users/dev/other/thing.md'), null)
  assert.equal(backlogLogicalPath(location, `${ELSEWHERE}-sibling/thing.md`), null)
})

run('absolute and logical are inverses', () => {
  for (const location of [defaultBacklogLocation(WORKSPACE), { workspaceRoot: WORKSPACE, root: ELSEWHERE }]) {
    for (const relative of ['backlog/a.md', 'backlog/epics/b.md', 'backlog/deep/nest/c.md']) {
      const absolute = backlogAbsolutePath(location, relative)
      assert.ok(absolute, `${relative} must resolve under ${location.root}`)
      assert.equal(backlogLogicalPath(location, absolute), relative)
    }
  }
})

// This replaced `isPathInsideOrEqual(workspace.root, target)`, which admitted
// anything inside the checkout. Against the backlog root it is strictly tighter,
// and it is the only containment check that still means anything once the root
// can sit outside the workspace.
run('traversal out of the backlog root is refused', () => {
  const location: BacklogLocation = { workspaceRoot: WORKSPACE, root: ELSEWHERE }
  for (const attempt of [
    'backlog/../secrets.md',
    'backlog/../../etc/passwd',
    'backlog/epics/../../../../etc/passwd',
    'backlog/a/../../b.md',
  ]) {
    assert.equal(backlogAbsolutePath(location, attempt), null, `${attempt} must be refused`)
  }
})

run('a path that is not under backlog/ is refused', () => {
  const location = defaultBacklogLocation(WORKSPACE)
  for (const attempt of ['src/main/index.ts', 'notbacklog/a.md', '.sprintengine/backlog/config.json', '']) {
    assert.equal(backlogAbsolutePath(location, attempt), null, `${attempt} must be refused`)
  }
})

run('a configured root of nothing means the default', () => {
  for (const configured of [undefined, null, '', '   ']) {
    const location = backlogLocationFor(WORKSPACE, configured)
    assert.equal(location.root, backlogRootPath(WORKSPACE))
    assert.ok(isDefaultBacklogLocation(location))
  }
})

run('a configured root is taken as given, trailing separators and all', () => {
  for (const configured of [ELSEWHERE, `${ELSEWHERE}/`, `${ELSEWHERE}//`, `  ${ELSEWHERE}  `]) {
    const location = backlogLocationFor(WORKSPACE, configured)
    assert.equal(location.root, ELSEWHERE, `${JSON.stringify(configured)} must normalize`)
    assert.equal(isDefaultBacklogLocation(location), false)
  }
})

// `setBacklogRoot` refuses to write a relative root, so this only guards a
// hand-edited config — where "relative to what" has no answer the main process,
// the renderer and the mobile bridge would all agree on.
run('a relative configured root is ignored rather than half-understood', () => {
  for (const configured of ['backlog', './backlog', '../shared/backlog', 'a/b']) {
    const location = backlogLocationFor(WORKSPACE, configured)
    assert.ok(isDefaultBacklogLocation(location), `${configured} must fall back to the default`)
  }
})

run('a configured root that happens to be the default reads as the default', () => {
  const location = backlogLocationFor(WORKSPACE, backlogRootPath(WORKSPACE))
  assert.ok(isDefaultBacklogLocation(location), 'a reset-to-default config is not a redirect')
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
  console.log('location.test.ts: ok')
}

main()
