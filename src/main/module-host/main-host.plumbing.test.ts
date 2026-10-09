import assert from 'node:assert/strict'
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

