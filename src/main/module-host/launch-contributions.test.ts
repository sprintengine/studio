import assert from 'node:assert/strict'

import {
  addLaunchContribution,
  collectLaunchContributions,
  EMPTY_LAUNCH_CONTRIBUTION,
  registeredLaunchContributionCount,
  removeLaunchContributionsForModule,
  resetLaunchContributionsForTest,
} from './launch-contributions'
import type { LaunchContributionRequest } from '../../shared/modules/launch-contributions'
import { createMainKernel } from './main-host'
import { createFakeIpcMain } from './ipc-main-fake.test-helper'
import { test } from 'vitest'

test('launch-contributions', async () => {
  function request(overrides: Partial<LaunchContributionRequest> = {}): LaunchContributionRequest {
    return {
      cli: 'codex',
      workspaceRoot: '/Users/dev/project',
      sessionId: 'session-1',
      pathStyle: 'posix',
      ...overrides,
    }
  }

  function main(): void {
    testNoContributionsIsTheEmptyMerge()
    testRegistrationOrderMergesEnvAndPathAndFunctions()
    testThrowingContributionIsSkippedAndRecorded()
    testSessionTagsOrTogether()
    testUnloadDropsAModuleContribution()
    testThrowingContributionIsRecordedAsAModuleDiagnostic()
    console.log('launch-contributions tests passed')
  }

  function testNoContributionsIsTheEmptyMerge(): void {
    resetLaunchContributionsForTest()
    const merged = collectLaunchContributions(request())
    assert.deepEqual(merged, EMPTY_LAUNCH_CONTRIBUTION)
    assert.equal(registeredLaunchContributionCount(), 0)
  }

  function testRegistrationOrderMergesEnvAndPathAndFunctions(): void {
    resetLaunchContributionsForTest()
    addLaunchContribution('alpha', () => ({
      env: { ALPHA: '1', SHARED: 'alpha' },
      pathEntries: ['/Users/dev/alpha-bin'],
      shellFunctions: ['alpha() { :; }'],
      hostContext: [{ heading: 'Alpha', body: 'From alpha.' }],
      mcpServers: [{ id: 'alpha-mcp', url: 'http://127.0.0.1:9' }],
      identityKeys: ['ALPHA_ID'],
    }))
    addLaunchContribution('beta', () => ({
      env: { BETA: '2', SHARED: 'beta' },
      pathEntries: ['/Users/dev/beta-bin'],
      shellFunctions: ['beta() { :; }'],
      hostContext: [{ heading: 'Beta', body: 'From beta.' }],
      mcpServers: [{ id: 'beta-mcp', command: 'beta-mcp' }],
      identityKeys: ['ALPHA_ID', 'BETA_ID'],
    }))

    const merged = collectLaunchContributions(request())
    assert.equal(merged.env.ALPHA, '1')
    assert.equal(merged.env.BETA, '2')
    assert.equal(merged.env.SHARED, 'beta', 'later modules overwrite the same env key')
    assert.deepEqual(merged.pathEntries, ['/Users/dev/alpha-bin', '/Users/dev/beta-bin'])
    assert.deepEqual(merged.shellFunctions, ['alpha() { :; }', 'beta() { :; }'])
    assert.deepEqual(merged.hostContext, [
      { heading: 'Alpha', body: 'From alpha.' },
      { heading: 'Beta', body: 'From beta.' },
    ])
    assert.deepEqual(merged.mcpServers, [
      { id: 'alpha-mcp', url: 'http://127.0.0.1:9' },
      { id: 'beta-mcp', command: 'beta-mcp' },
    ])
    assert.deepEqual(merged.identityKeys, ['ALPHA_ID', 'BETA_ID'])
    assert.deepEqual(merged.failures, [])
  }

  function testThrowingContributionIsSkippedAndRecorded(): void {
    resetLaunchContributionsForTest()
    const reported: { moduleId: string; message: string }[] = []
    addLaunchContribution('good', () => ({ env: { GOOD: '1' } }))
    addLaunchContribution('boom', () => {
      throw new Error('contribution exploded')
    })
    addLaunchContribution('after', () => ({ env: { AFTER: '1' } }))

    const merged = collectLaunchContributions(request(), (failure) => reported.push(failure))
    assert.equal(merged.env.GOOD, '1')
    assert.equal(merged.env.AFTER, '1')
    assert.deepEqual(merged.failures, [{ moduleId: 'boom', message: 'contribution exploded' }])
    assert.deepEqual(reported, [{ moduleId: 'boom', message: 'contribution exploded' }])
  }

  function testSessionTagsOrTogether(): void {
    resetLaunchContributionsForTest()
    addLaunchContribution('plain', () => ({ session: { managed: false } }))
    addLaunchContribution('owner', () => ({ session: { managed: true, reapExempt: true } }))
    const merged = collectLaunchContributions(request())
    assert.deepEqual(merged.session, { managed: true, reapExempt: true })
  }

  function testUnloadDropsAModuleContribution(): void {
    resetLaunchContributionsForTest()
    addLaunchContribution('alpha', () => ({ env: { ALPHA: '1' } }))
    addLaunchContribution('beta', () => ({ env: { BETA: '1' } }))
    removeLaunchContributionsForModule('alpha')
    const merged = collectLaunchContributions(request())
    assert.equal(merged.env.ALPHA, undefined)
    assert.equal(merged.env.BETA, '1')
    assert.equal(registeredLaunchContributionCount(), 1)
  }

  function testThrowingContributionIsRecordedAsAModuleDiagnostic(): void {
    resetLaunchContributionsForTest()
    const { ipcMain } = createFakeIpcMain()
    const kernel = createMainKernel(ipcMain)
    kernel.hostFor('boom').registerLaunchContribution(() => {
      throw new Error('contribution exploded')
    })
    const merged = collectLaunchContributions(request())
    assert.deepEqual(merged.failures, [{ moduleId: 'boom', message: 'contribution exploded' }])
    const notes = kernel.recentNotifications()
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.sourceModuleId, 'boom')
    assert.equal(notes[0]?.severity, 'warning')
    assert.equal(notes[0]?.title, 'Launch contribution failed')
    assert.equal(notes[0]?.body, 'contribution exploded')
    resetLaunchContributionsForTest()
  }

  main()
})
