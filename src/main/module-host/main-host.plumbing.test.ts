import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createFakeIpcMain } from './ipc-main-fake.test-helper'
import { createMainKernel, type MainKernelOptions, type ModuleSkillHostRegistry } from './main-host'

// The main-host plumbing a module reaches through its scoped host: skill
// status, module app state, workspace git info, the module's data directory
// and asset paths. Each is a thin host method over a service; what is pinned
// here is the host's half — scoping, permission gates, refusals.

function kernelWith(options: MainKernelOptions = {}) {
  return createMainKernel(createFakeIpcMain().ipcMain, options)
}

test('getSkillStatus reads through the skill registry and writes nothing', async () => {
  const calls: string[] = []
  const skillRegistry: ModuleSkillHostRegistry = {
    register() {},
    unregister() {},
    async ensureInstalled(root, id) {
      calls.push(`ensure:${root}:${id}`)
      return { ok: true, status: 'installed' }
    },
    async getStatus(root, id) {
      calls.push(`status:${root}:${id}`)
      return { ok: false, status: 'missing' }
    },
  }
  const kernel = kernelWith({ skillRegistry })
  assert.deepEqual(await kernel.hostFor('decision-log').getSkillStatus('/Users/dev/acme', 'decision-log'), {
    ok: false,
    status: 'missing',
  })
  assert.deepEqual(calls, ['status:/Users/dev/acme:decision-log'])
})

test('getWorkspaceGitInfo needs ipc:workspace-read from a third-party module', async () => {
  const permissions: Record<string, string[]> = { 'pr-radar': ['ipc:workspace-read'], sloppy: [] }
  const kernel = kernelWith({
    resolveModuleManifest: (id) =>
      id in permissions
        ? {
            id,
            displayName: id,
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            permissions: permissions[id],
            engines: { hostApi: 1 },
          }
        : undefined,
  })
  const before = await kernel.hostFor('pr-radar').getWorkspaceGitInfo('ws-1')
  assert.equal(before.ok === false && before.code, 'unavailable', 'no reader is provided yet')

  const asked: string[] = []
  kernel.hostFor('agent-runtime').provideService({ key: 'core.workspace-git-info' }, () => ({
    read: async (workspaceId: string) => {
      asked.push(workspaceId)
      return { ok: true as const, branch: 'main', remotes: [] }
    },
  }))
  assert.deepEqual(await kernel.hostFor('pr-radar').getWorkspaceGitInfo('ws-1'), {
    ok: true,
    branch: 'main',
    remotes: [],
  })
  const refused = await kernel.hostFor('sloppy').getWorkspaceGitInfo('ws-1')
  assert.equal(refused.ok === false && refused.code, 'permission_missing')
  assert.deepEqual(asked, ['ws-1'], 'a refused module never reaches the reader')
})

test('getModuleDataDir is the storage service directory for this module', () => {
  const kernel = kernelWith()
  assert.throws(() => kernel.hostFor('insights').getModuleDataDir(), /no storage service/)
  const asked: string[] = []
  kernel.hostFor('agent-runtime').provideService({ key: 'core.module-storage' }, () => ({
    dataDir: (moduleId: string) => {
      asked.push(moduleId)
      return `/Users/dev/app-data/module-data/${moduleId}`
    },
  }))
  assert.equal(kernel.hostFor('insights').getModuleDataDir(), '/Users/dev/app-data/module-data/insights')
  assert.deepEqual(asked, ['insights'])
})

test('getAssetPath resolves only verified files whose bytes still match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-asset-path-'))
  try {
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'worker.cjs'), 'module.exports = 1\n')
    await writeFile(join(root, 'dist', 'unlisted.cjs'), 'module.exports = 2\n')
    const digest = createHash('sha256').update('module.exports = 1\n').digest('hex')
    const kernel = kernelWith({
      resolveModuleRoot: (id) => (id === 'insights' ? root : undefined),
      resolveModuleVerifiedFiles: (id) => (id === 'insights' ? { 'dist/worker.cjs': digest } : undefined),
    })
    const host = kernel.hostFor('insights')
    assert.equal(host.getAssetPath('dist/worker.cjs'), await realpath(join(root, 'dist', 'worker.cjs')))
    assert.throws(() => host.getAssetPath('dist/unlisted.cjs'), /not among .* verified files/)
    for (const bad of ['/dist/worker.cjs', '../worker.cjs', 'dist/../dist/worker.cjs', 'dist\\worker.cjs', '']) {
      assert.throws(() => host.getAssetPath(bad), /module-relative file path/, bad)
    }
    await writeFile(join(root, 'dist', 'worker.cjs'), 'module.exports = "swapped"\n')
    assert.throws(() => host.getAssetPath('dist/worker.cjs'), /changed after it was verified/)
    assert.throws(() => kernel.hostFor('bundled').getAssetPath('dist/worker.cjs'), /no verified files/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
