import assert from 'node:assert/strict'

import { HOST_API_VERSION } from '../../shared/modules/host-api'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import {
  readThirdPartyMainLaunchSnapshot,
  recordThirdPartyMainLaunchReport,
  type ThirdPartyMainLaunchSnapshot,
} from '../modules/third-party-main-loader'
import type { InstalledModule } from '../modules/user-module-registry'
import { toThirdPartyModuleView } from './third-party-module-ipc'
import { test } from 'vitest'

test('third-party-module-ipc', async () => {
  function main(): void {
    testLaunchReadinessClasses()
    testExpectedToLoadUsesEnablementOverrides()
    testCurrentBlockedStateWinsOverStaleLaunchError()
    testLaunchErrorsAreSanitized()
    testHostApiMismatchIsSaidBeforeTrust()

    console.log('third-party-module-ipc tests passed')
  }

  function testLaunchReadinessClasses(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(['trusted-main']),
      manifestOnly: new Set(['manifest-only']),
      errors: new Map([['broken-main', 'entry.main must export a callable registerMain(host).']]),
    }

    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'trusted-main', trust: 'trusted', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'trusted_executable',
        hasMainEntry: true,
        expectedToLoad: true,
        rendererEntry: { availability: 'none' },
        message: 'Trusted main entry is eligible for startup execution.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'manifest-only', trust: 'trusted' }), snapshot).launch,
      {
        status: 'trusted_manifest_only',
        hasMainEntry: false,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Trusted manifest-only module; no main entry will run.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'unsigned', trust: 'unsigned', main: 'main.cjs' }), snapshot).launch,
      {
        status: 'blocked_unsigned',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Unsigned module is waiting for trust before startup execution.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'signed', trust: 'signed', main: 'main.cjs' }), snapshot).launch,
      {
        status: 'blocked_signed',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Signed module is waiting for trust before startup execution.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'invalid', trust: 'invalid', main: 'main.cjs' }), snapshot).launch,
      {
        status: 'blocked_invalid',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Invalid signature blocks startup execution.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'broken-main', trust: 'trusted', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'launch_error',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'entry.main must export a callable registerMain(host).',
      },
    )
  }

  function testExpectedToLoadUsesEnablementOverrides(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(['default-on-disabled']),
      manifestOnly: new Set(),
      errors: new Map(),
    }

    assert.deepEqual(
      toThirdPartyModuleView(
        installedModule({ id: 'default-on-disabled', trust: 'trusted', main: 'main.cjs', defaultEnabled: true }),
        snapshot,
        { 'default-on-disabled': false },
      ).launch,
      {
        status: 'trusted_executable',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Trusted main entry is disabled by user setting until enabled.',
      },
    )
    assert.deepEqual(
      toThirdPartyModuleView(
        installedModule({ id: 'default-off-enabled', trust: 'trusted', main: 'main.cjs', defaultEnabled: false }),
        snapshot,
        { 'default-off-enabled': true },
      ).launch,
      {
        status: 'trusted_executable',
        hasMainEntry: true,
        expectedToLoad: true,
        rendererEntry: { availability: 'none' },
        message: 'Trusted main entry is eligible for startup execution.',
      },
    )
  }

  function testCurrentBlockedStateWinsOverStaleLaunchError(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = {
      loaded: new Set(),
      manifestOnly: new Set(),
      errors: new Map([['changed-module', 'Previous startup failed.']]),
    }

    assert.deepEqual(
      toThirdPartyModuleView(installedModule({ id: 'changed-module', trust: 'unsigned', main: 'main.cjs' }), snapshot)
        .launch,
      {
        status: 'blocked_unsigned',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Unsigned module is waiting for trust before startup execution.',
      },
    )
  }

  function testLaunchErrorsAreSanitized(): void {
    recordThirdPartyMainLaunchReport(['broken-main'], {
      loaded: [],
      manifestOnly: [],
      disabled: [],
      sidecars: [],
      errors: [
        {
          id: 'broken-main',
          message: "Cannot find module '/Users/example/.sprintengine/modules/broken-main/main.cjs'",
        },
      ],
    })

    assert.deepEqual(
      toThirdPartyModuleView(
        installedModule({ id: 'broken-main', trust: 'trusted', main: 'main.cjs' }),
        readThirdPartyMainLaunchSnapshot(),
      ).launch,
      {
        status: 'launch_error',
        hasMainEntry: true,
        expectedToLoad: false,
        rendererEntry: { availability: 'none' },
        message: 'Module main entry failed during startup.',
      },
    )
  }

  // A module built for a host API this app does not provide loads neither
  // entry, and trusting it would not help: the row says why, even for a
  // trusted renderer-only module, whose renderer line alone used to say nothing.
  function testHostApiMismatchIsSaidBeforeTrust(): void {
    const snapshot: ThirdPartyMainLaunchSnapshot = { loaded: new Set(), manifestOnly: new Set(), errors: new Map() }
    const tooNew = toThirdPartyModuleView(
      installedModule({ id: 'future', trust: 'trusted', main: 'main.cjs', hostApi: HOST_API_VERSION + 1 }),
      snapshot,
    ).launch
    assert.equal(tooNew.status, 'blocked_host_api')
    assert.equal(tooNew.expectedToLoad, false)
    assert.match(tooNew.message ?? '', /host API/i)

    const rendererOnly = installedModule({ id: 'renderer-only', trust: 'trusted', hostApi: HOST_API_VERSION + 1 })
    rendererOnly.manifest.entry = { renderer: 'dist/renderer.mjs' }
    assert.equal(toThirdPartyModuleView(rendererOnly, snapshot).launch.status, 'blocked_host_api')

    // An unsigned one still says it is built for another host API: trusting
    // it is not the step that would make it load.
    assert.equal(
      toThirdPartyModuleView(installedModule({ id: 'u', trust: 'unsigned', hostApi: 0 }), snapshot).launch.status,
      'blocked_host_api',
    )
    // A tampered module keeps its own, louder, reason.
    assert.equal(
      toThirdPartyModuleView(installedModule({ id: 'bad', trust: 'invalid', hostApi: 99 }), snapshot).launch.status,
      'blocked_invalid',
    )
  }

  function installedModule(options: {
    id: string
    trust: InstalledModule['trust']['status']
    main?: string
    defaultEnabled?: boolean
    hostApi?: number
  }): InstalledModule {
    const manifest: CapabilityManifest = {
      id: options.id,
      displayName: options.id,
      version: 1,
      defaultEnabled: options.defaultEnabled ?? true,
      source: 'third-party',
      engines: { hostApi: options.hostApi ?? HOST_API_VERSION },
    }
    if (options.main) manifest.entry = { main: options.main }
    return {
      manifest,
      moduleRoot: 'test-root',
      trust: { status: options.trust },
    }
  }

  main()
})
