import assert from 'node:assert/strict'

import { remoteProjectOfWorkspace, remoteProjectsOf } from './remoteProjects'
import type { FleetWorkspace } from '../../../../../shared/tailnet-fleet'
import { test } from 'vitest'

test('remoteProjects', async () => {
  // The fold that turned the remote project chip from a list of the other
  // machine's CHATS into a list of its projects.

  let failures = 0
  function check(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.log(`not ok - ${name}`)
      console.error(error)
    }
  }

  const repo = (name: string) => ({
    canonicalKey: `github.com/acme/${name}`,
    remoteUrl: `git@github.com:acme/${name}.git`,
    name,
  })

  const chat = (
    id: string,
    name: string,
    folderPath: string | null,
    repository = null as FleetWorkspace['repository'],
  ): FleetWorkspace => ({
    id,
    name,
    mode: 'standard',
    folderPath,
    repository,
  })

  check('chats in one folder are one project, named after the folder', () => {
    const projects = remoteProjectsOf([
      chat('w3', 'Yeah, that’s a good spot', '/Users/dev/sprintengine'),
      chat('w1', 'Improve Search Glass Effect', '/Users/dev/sprintengine'),
      chat('w2', 'Fix Reaped Terminal Brightness', '/Users/dev/sprintengine'),
    ])
    assert.equal(projects.length, 1, 'three chats in one checkout are one row')
    assert.equal(projects[0]!.name, 'sprintengine', 'named after the folder, not after a chat')
    assert.equal(projects[0]!.folderPath, '/Users/dev/sprintengine')
    assert.equal(projects[0]!.conversationCount, 3)
  })

  check('the seat is the lowest id, so a re-read does not move it', () => {
    const first = remoteProjectsOf([chat('w3', 'c', '/srv/app'), chat('w1', 'a', '/srv/app')])
    const reordered = remoteProjectsOf([chat('w1', 'a', '/srv/app'), chat('w3', 'c', '/srv/app')])
    assert.equal(first[0]!.workspaceId, 'w1')
    assert.equal(reordered[0]!.workspaceId, 'w1', 'list order does not change which workspace answers for the folder')
  })

  check('two folders of one repository stay two projects', () => {
    // A worktree checkout is the same repository and a DIFFERENT folder. Merging
    // them would pick one of the two paths for a launch to land in.
    const projects = remoteProjectsOf([
      chat('w1', 'main chat', '/srv/app', repo('app')),
      chat('w2', 'worktree chat', '/srv/app-feature', repo('app')),
    ])
    assert.deepEqual(
      projects.map((project) => project.folderPath),
      ['/srv/app', '/srv/app-feature'],
    )
  })

  check('trailing slashes, backslashes and case are one folder', () => {
    const projects = remoteProjectsOf([
      chat('w1', 'a', '/srv/app/'),
      chat('w2', 'b', '/srv/App'),
      chat('w3', 'c', '\\srv\\app'),
    ])
    assert.equal(projects.length, 1)
    assert.equal(projects[0]!.conversationCount, 3)
  })

  check('a chat with no folder is not a project', () => {
    const projects = remoteProjectsOf([chat('w1', 'folderless', null), chat('w2', 'blank', '   ')])
    assert.deepEqual(projects, [], 'there is nowhere for a new chat to run, so there is no row to pick')
  })

  check('the repository is taken from whichever chat in the folder could answer', () => {
    const projects = remoteProjectsOf([chat('w1', 'a', '/srv/app', null), chat('w2', 'b', '/srv/app', repo('app'))])
    assert.equal(projects[0]!.repository?.canonicalKey, 'github.com/acme/app')
  })

  check('projects come back in name order', () => {
    const projects = remoteProjectsOf([
      chat('w1', 'a', '/srv/zebra'),
      chat('w2', 'b', '/srv/apple'),
      chat('w3', 'c', '/srv/mango'),
    ])
    assert.deepEqual(
      projects.map((project) => project.name),
      ['apple', 'mango', 'zebra'],
    )
  })

  check('a machine copy found by repository resolves to the folder it stands in', () => {
    const workspaces = [
      chat('w1', 'other', '/srv/other', repo('other')),
      chat('w2', 'sprintengine-air', '/srv/sprintengine', repo('sprintengine')),
    ]
    const projects = remoteProjectsOf(workspaces)
    const found = remoteProjectOfWorkspace(projects, workspaces, 'w2')
    assert.equal(found?.name, 'sprintengine')
    assert.equal(
      remoteProjectOfWorkspace(projects, workspaces, 'nope'),
      null,
      'an id the read no longer holds resolves to nothing',
    )
  })

  if (failures > 0) {
    console.error(`remoteProjects.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('remoteProjects.test.ts: ok')
})
