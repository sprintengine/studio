import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createNodeStudioPaths, defaultServerLocations } from './studio-paths'

test('a server with no data directory uses the XDG directories, on Linux and over SSH to a Mac alike', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.deepEqual(defaultServerLocations({ platform, env: {}, home: '/home/dev' }), {
      dataDir: '/home/dev/.local/share/sprintengine-studio/data',
      logsDir: '/home/dev/.local/state/sprintengine-studio/logs',
    })
  }
  assert.deepEqual(
    defaultServerLocations({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data/xdg', XDG_STATE_HOME: '/state/xdg' },
      home: '/home/dev',
    }),
    { dataDir: '/data/xdg/sprintengine-studio/data', logsDir: '/state/xdg/sprintengine-studio/logs' },
  )
})

test('a relative or empty XDG variable is ignored, as the spec says', () => {
  assert.deepEqual(
    defaultServerLocations({
      platform: 'linux',
      env: { XDG_DATA_HOME: 'relative', XDG_STATE_HOME: '  ' },
      home: '/home/dev',
    }),
    {
      dataDir: '/home/dev/.local/share/sprintengine-studio/data',
      logsDir: '/home/dev/.local/state/sprintengine-studio/logs',
    },
  )
})

test('Windows paths are spelled the Windows way whatever the host running the test', () => {
  assert.deepEqual(
    defaultServerLocations({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
      home: 'C:\\Users\\dev',
    }),
    {
      dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio\\data',
      logsDir: 'C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio\\logs',
    },
  )
  assert.equal(
    defaultServerLocations({ platform: 'win32', env: {}, home: 'C:\\Users\\dev' }).dataDir,
    'C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio\\data',
  )
})

test('node paths answer what the server was started with, and a source checkout by default', () => {
  const paths = createNodeStudioPaths({ dataDir: '/srv/studio/data', logsDir: '/srv/studio/logs' })
  assert.equal(paths.dataDir(), '/srv/studio/data')
  assert.equal(paths.logsDir(), '/srv/studio/logs')
  assert.equal(paths.isPackaged(), false)
  assert.equal(paths.resourcesDir(), null)
  assert.equal(paths.appRoot(), null)

  const packaged = createNodeStudioPaths({
    dataDir: '/srv/studio/data',
    packaged: true,
    resourcesDir: '/opt/studio/resources',
    appRoot: '/opt/studio',
  })
  assert.equal(packaged.isPackaged(), true)
  assert.equal(packaged.resourcesDir(), '/opt/studio/resources')
  assert.equal(packaged.appRoot(), '/opt/studio')
})
