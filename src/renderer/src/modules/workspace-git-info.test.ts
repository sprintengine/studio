import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { createRendererHost } from './renderer-host'

// RendererHost.getWorkspaceGitInfo: the permission is checked here, before the
// shell's git read is asked anything.

function manifest(permissions: string[]): CapabilityManifest {
  return { id: 'pr-radar', displayName: 'PR Radar', version: 1, defaultEnabled: true, source: 'third-party', permissions }
}

test('a module without ipc:workspace-read is refused before the source is asked', async () => {
  const kernel = createRendererHost()
  let asked = 0
  kernel.setWorkspaceGitInfoSource(async () => {
    asked += 1
    return { ok: true, branch: 'main', remotes: [] }
  })
  const result = await kernel.hostFor('pr-radar', manifest([])).getWorkspaceGitInfo('ws-1')
  assert.equal(result.ok === false && result.code, 'permission_missing')
  assert.equal(asked, 0)
})

test('before the shell wires a source the read is unavailable, not a throw', async () => {
  const result = await createRendererHost()
    .hostFor('pr-radar', manifest(['ipc:workspace-read']))
    .getWorkspaceGitInfo('ws-1')
  assert.equal(result.ok === false && result.code, 'unavailable')
})

test('a wired source answers for the workspace asked about', async () => {
  const kernel = createRendererHost()
  kernel.setWorkspaceGitInfoSource(async (workspaceId) => ({
    ok: true,
    branch: workspaceId === 'ws-1' ? 'radar' : null,
    remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git', github: 'acme/app' }],
  }))
  assert.deepEqual(await kernel.hostFor('pr-radar', manifest(['ipc:workspace-read'])).getWorkspaceGitInfo('ws-1'), {
    ok: true,
    branch: 'radar',
    remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git', github: 'acme/app' }],
  })
})

test('a source that throws is a git_failed result', async () => {
  const kernel = createRendererHost()
  kernel.setWorkspaceGitInfoSource(async () => {
    throw new Error('ipc closed')
  })
  const result = await kernel.hostFor('pr-radar', manifest(['ipc:workspace-read'])).getWorkspaceGitInfo('ws-1')
  assert.equal(result.ok === false && result.code, 'git_failed')
})
