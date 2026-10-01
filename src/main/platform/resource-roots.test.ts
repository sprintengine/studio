import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createNodeStudioPlatform, installStudioPlatform, resetStudioPlatform } from '../../server/platform/platform'
import { builtinSkillSourceRoot } from '../builtin-skills'
import { currentRuntimeEnv } from '../managed-runtime'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'

// The resource lookups that used to ask Electron whether the build is packaged
// and where its resources are now ask the installed platform, and answer as a
// source checkout when none is installed, as they did outside Electron.

const RESOURCES = '/Applications/Studio.app/Contents/Resources'
const APP_ROOT = join(RESOURCES, 'app.asar')

function installPackaged(): void {
  installStudioPlatform(
    createNodeStudioPlatform({
      dataDir: '/Users/dev/studio-data',
      packaged: true,
      resourcesDir: RESOURCES,
      appRoot: APP_ROOT,
      version: '0.4.0',
    }),
  )
}

afterEach(() => resetStudioPlatform())

test('an installed build finds its bundled skills and runtimes under the resources root', () => {
  installPackaged()
  assert.equal(builtinSkillSourceRoot(), join(RESOURCES, 'builtin-skills'))
  const env = currentRuntimeEnv({ exists: () => false })
  assert.equal(env.isPackaged, true)
  assert.equal(env.resourcesPath, RESOURCES)
})

test('a source checkout looks in the working tree', () => {
  installStudioPlatform(createNodeStudioPlatform({ dataDir: '/Users/dev/studio-data', version: '0.0.0' }))
  assert.equal(builtinSkillSourceRoot(), join(process.cwd(), 'resources', 'builtin-skills'))
})

test('with no platform the runtime and marketplace lookups answer as a source checkout', () => {
  const env = currentRuntimeEnv({ exists: () => false })
  assert.equal(env.isPackaged, false)
  assert.equal(env.resourcesPath, undefined)

  const looked: string[] = []
  findMarketplaceResourcePath('registry.json', {
    cwd: '/Users/dev/checkout',
    dirname: '/Users/dev/checkout/out/main',
    exists: (path) => {
      looked.push(path)
      return false
    },
  })
  assert.equal(looked[0], '/Users/dev/checkout/resources/marketplace/registry.json')
})

test('an installed build looks for marketplace files in its resources, and never unions the dev trust keys', () => {
  installPackaged()
  const looked: string[] = []
  findMarketplaceResourcePath('trusted-publishers.json', {
    exists: (path) => {
      looked.push(path)
      return false
    },
  })
  assert.deepEqual(looked, [
    join(RESOURCES, 'marketplace', 'trusted-publishers.json'),
    join(APP_ROOT, 'resources', 'marketplace', 'trusted-publishers.json'),
  ])

  const asked: string[] = []
  readTrustedMarketplacePublisherFingerprintsSync({
    resolveResourcePath: (relative) => {
      asked.push(relative)
      return null
    },
  })
  assert.deepEqual(asked, ['trusted-publishers.json'])
})
