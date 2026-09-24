import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AppUpdateState, CliVersionAdvisory, CliVersionAdvisoryMap } from '../../../shared/electron-api'
import {
  appUpdateKey,
  cliUpdateKey,
  outstandingAppUpdate,
  outstandingCliUpdates,
  settingsUpdateBadges,
} from './settingsUpdateBadges'

// The Settings update badges (owner ruling 2026-09-25): the rail's gear, the
// General and Agents nav items, the machine switcher and a CLI's row, all from
// one derivation. Each appears while an update is outstanding and clears when it
// is installed or dismissed.

function advisory(cli: string, over: Partial<CliVersionAdvisory> = {}): CliVersionAdvisory {
  return {
    cli: cli as CliVersionAdvisory['cli'],
    status: 'behind_latest',
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateCommand: null,
    checkedAt: '2026-09-25T00:00:00.000Z',
    ...over,
  }
}

function appState(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'not_available',
    version: '0.6.0',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    ...over,
  }
}

const everyCliInstalled = (): boolean => true

test('a CLI update counts while it is behind, installed here, checked for and not dismissed', () => {
  const advisories: CliVersionAdvisoryMap = {
    codex: advisory('codex'),
    gemini: advisory('gemini', { status: 'current', latestVersion: '1.0.0' }),
    opencode: advisory('opencode', { status: 'unknown' }),
    cursor: advisory('cursor', { latestVersion: null }),
  }
  const base = { advisories, checkCliVersions: true, installed: everyCliInstalled, dismissed: [] }
  assert.deepEqual(
    outstandingCliUpdates(base).map((entry) => entry.cli),
    ['codex'],
    'current, unknown and version-less advisories are not news',
  )
  assert.deepEqual(outstandingCliUpdates({ ...base, checkCliVersions: false }), [], 'checks off, nothing counted')
  assert.deepEqual(
    outstandingCliUpdates({ ...base, installed: (cli) => cli !== 'codex' }),
    [],
    'a CLI no longer detected here offers no Update, so it wears no badge',
  )
  assert.deepEqual(
    outstandingCliUpdates({ ...base, dismissed: [cliUpdateKey(advisories.codex!)] }),
    [],
    'a dismissed version is not counted',
  )
  assert.deepEqual(
    outstandingCliUpdates({
      ...base,
      advisories: { codex: advisory('codex', { latestVersion: '1.2.0' }) },
      dismissed: [cliUpdateKey(advisories.codex!)],
    }).map((entry) => entry.latestVersion),
    ['1.2.0'],
    'a newer release than the dismissed one badges again',
  )
  assert.deepEqual(
    outstandingCliUpdates({ ...base, advisories: { codex: advisory('codex', { status: 'current' }) } }),
    [],
    'installed: the advisory stops saying behind, and the badge goes',
  )
})

test('the app update counts from available to ready, and clears when installed or dismissed', () => {
  assert.equal(outstandingAppUpdate({ state: null, dismissed: [] }), null, 'nothing known yet')
  assert.equal(outstandingAppUpdate({ state: appState(), dismissed: [] }), null, 'up to date')
  for (const status of ['available', 'downloading'] as const) {
    assert.deepEqual(outstandingAppUpdate({ state: appState({ status, updateVersion: '0.7.0' }), dismissed: [] }), {
      version: '0.7.0',
    })
  }
  assert.deepEqual(
    outstandingAppUpdate({
      state: appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' }),
      dismissed: [],
    }),
    { version: '0.7.0' },
    'ready to install',
  )
  assert.equal(
    outstandingAppUpdate({
      state: appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' }),
      dismissed: [appUpdateKey('0.7.0')],
    }),
    null,
    'Later on the toast dismisses this version',
  )
  assert.equal(
    outstandingAppUpdate({
      state: appState({ status: 'available', updateVersion: '0.7.0', packaged: false }),
      dismissed: [],
    }),
    null,
    'an unpackaged build installs nothing',
  )
  assert.equal(
    outstandingAppUpdate({ state: appState({ status: 'error', updateVersion: '0.7.0' }), dismissed: [] }),
    null,
    'a failed check or download is not an update waiting',
  )
})

test('one derivation feeds the gear, General, Agents, the switcher and the rows', () => {
  const none = settingsUpdateBadges({ cliUpdates: [], appUpdate: null })
  assert.equal(none.rail, null, 'nothing waiting draws nothing — never a 0')
  assert.equal(none.general, null)
  assert.equal(none.agents, null)
  assert.deepEqual(none.machines, {})
  assert.equal(none.clis.size, 0)

  const cliOnly = settingsUpdateBadges({ cliUpdates: [advisory('codex'), advisory('gemini')], appUpdate: null })
  assert.deepEqual(cliOnly.agents, {
    count: 2,
    tone: 'accent',
    label: 'Agents: 2 CLI updates available',
    detail: '2 CLI updates available',
  })
  assert.equal(cliOnly.general, null, 'General only badges for the app')
  assert.deepEqual(cliOnly.machines, { local: cliOnly.agents }, 'the advisories are this PC’s, so only This PC badges')
  assert.deepEqual([...cliOnly.clis], ['codex', 'gemini'])
  assert.equal(cliOnly.rail?.count, 2)
  assert.equal(cliOnly.rail?.label, '2 updates available')

  const both = settingsUpdateBadges({ cliUpdates: [advisory('codex')], appUpdate: { version: '0.7.0' } })
  assert.deepEqual(both.general, {
    count: 1,
    tone: 'accent',
    label: 'General: update available',
    detail: 'Update available',
  })
  assert.equal(both.agents?.detail, '1 CLI update available')
  assert.equal(both.rail?.count, 2, 'the gear counts the app and the CLIs together')

  const appOnly = settingsUpdateBadges({ cliUpdates: [], appUpdate: { version: '0.7.0' } })
  assert.deepEqual(appOnly.rail, {
    count: 1,
    tone: 'accent',
    label: '1 update available',
    detail: '1 update available',
  })
  assert.equal(appOnly.agents, null)
})
