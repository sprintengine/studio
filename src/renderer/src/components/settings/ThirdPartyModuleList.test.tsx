import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleTrustStatus,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import type { ThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import {
  ThirdPartyModuleRow,
  describeModuleLaunch,
  describeRendererEntry,
  resolveModuleEnabled,
} from './ThirdPartyModuleList'

// Status mapping and copy are security-sensitive: launch readiness must never
// read as sandboxed execution, a manifest-only module must never look failed or
// running, an invalid signature must never expose a trust toggle, and a trusted
// executable module must offer a usable enable affordance (not a dead end).

function launch(overrides: Partial<ThirdPartyModuleLaunchView>): ThirdPartyModuleLaunchView {
  return { status: 'trusted_executable', hasMainEntry: true, expectedToLoad: true, ...overrides }
}

function moduleView(
  trust: ModuleTrustStatus,
  launchView: ThirdPartyModuleLaunchView,
  manifest: Partial<CapabilityManifest> = {}
): ThirdPartyModuleView {
  return {
    manifest: { id: 'demo', displayName: 'Demo Module', defaultEnabled: false, ...manifest } as CapabilityManifest,
    trust,
    launch: launchView,
  }
}

function renderRow(
  view: ThirdPartyModuleView,
  opts: {
    pending?: boolean
    enabled?: boolean
    rendererLoadState?: ThirdPartyRendererLoadState
    onUninstall?: () => void
  } = {}
): string {
  return renderToStaticMarkup(
    <ThirdPartyModuleRow
      module={view}
      pending={opts.pending ?? false}
      enabled={opts.enabled ?? false}
      rendererLoadState={opts.rendererLoadState}
      onTrustChange={() => {}}
      onEnabledChange={() => {}}
      {...(opts.onUninstall ? { onUninstall: opts.onUninstall } : {})}
    />
  )
}

function countSwitches(html: string): number {
  return Array.from(html.matchAll(/role="switch"/g)).length
}

function testDescribeLaunchMapsEveryStatus(): void {
  // Trusted + executable + enabled communicates next-launch loading.
  const ready = describeModuleLaunch(launch({ status: 'trusted_executable' }), true)
  assert.equal(ready.label, 'Main entry ready')
  assert.match(ready.detail, /next app launch/i)
  assert.doesNotMatch(ready.detail, /disabled/i)

  // Trusted executable but disabled points at the enable affordance, not a dead end.
  const disabled = describeModuleLaunch(launch({ status: 'trusted_executable' }), false)
  assert.match(disabled.detail, /enable it to load on the next app launch/i)

  // Manifest-only is a healthy terminal state: not failed, not running.
  const manifestOnly = describeModuleLaunch(
    launch({ status: 'trusted_manifest_only', hasMainEntry: false }),
    false
  )
  assert.equal(manifestOnly.label, 'Manifest only')
  assert.match(manifestOnly.detail, /no code to run/i)
  assert.doesNotMatch(manifestOnly.detail, /error|failed|running/i)

  const unsigned = describeModuleLaunch(launch({ status: 'blocked_unsigned' }), false)
  assert.equal(unsigned.label, 'Blocked until trusted')
  assert.match(unsigned.detail, /trust it/i)

  const signed = describeModuleLaunch(launch({ status: 'blocked_signed' }), false)
  assert.match(signed.detail, /trust it/i)

  const invalid = describeModuleLaunch(launch({ status: 'blocked_invalid' }), false)
  assert.equal(invalid.label, 'Blocked: invalid signature')
  assert.match(invalid.detail, /valid signature/i)

  // Launch error surfaces the real startup error string verbatim.
  const error = describeModuleLaunch(launch({ status: 'launch_error', message: 'registerMain threw: boom' }), false)
  assert.equal(error.label, 'Launch error')
  assert.equal(error.detail, 'registerMain threw: boom')

  const errorNoMessage = describeModuleLaunch(launch({ status: 'launch_error' }), false)
  assert.match(errorNoMessage.detail, /last app launch/i)
}

function testResolveModuleEnabledPrefersOverrideThenDefault(): void {
  const enabledByDefault = moduleView('trusted', launch({}), { id: 'a', defaultEnabled: true })
  const disabledByDefault = moduleView('trusted', launch({}), { id: 'b', defaultEnabled: false })

  // Missing override falls back to the manifest default.
  assert.equal(resolveModuleEnabled({}, enabledByDefault), true)
  assert.equal(resolveModuleEnabled({}, disabledByDefault), false)

  // An explicit override wins over the default, both directions.
  assert.equal(resolveModuleEnabled({ a: false }, enabledByDefault), false)
  assert.equal(resolveModuleEnabled({ b: true }, disabledByDefault), true)

  // Override intent is preserved: resolving one module ignores other modules'
  // overrides and never mutates the map (a pure per-id read). The row writes the
  // change through the per-id, merging store setter, so unrelated overrides
  // (including bundled modules) survive.
  const overrides: ModuleEnablementOverrides = { 'bundled.git': true, 'bundled.terminal': false }
  const before = JSON.stringify(overrides)
  assert.equal(resolveModuleEnabled(overrides, disabledByDefault), false)
  assert.equal(JSON.stringify(overrides), before, 'resolve must not mutate the override map')
}

function testTrustedExecutableEnabledRow(): void {
  const html = renderRow(moduleView('trusted', launch({ status: 'trusted_executable' })), { enabled: true })
  assert.ok(html.includes('Trusted'), 'trust label text shown')
  assert.equal(countSwitches(html), 2, 'trust switch + enable switch')
  assert.ok(html.includes('aria-label="Trust Demo Module"'), 'trust switch has accessible name')
  assert.ok(html.includes('Load on the next app launch'), 'enable affordance is labelled')
  assert.match(html, /Main entry ready/)
  assert.match(html, /Loads on the next app launch/i)
}

function testTrustedExecutableDisabledRowIsNotADeadEnd(): void {
  const html = renderRow(moduleView('trusted', launch({ status: 'trusted_executable' })), { enabled: false })
  // The disabled trusted module still exposes the enable control (the bug fix).
  assert.equal(countSwitches(html), 2, 'enable switch present even when disabled')
  assert.ok(html.includes('Load on the next app launch'))
  // Exactly one switch is on (trust); the enable switch is off.
  assert.equal(Array.from(html.matchAll(/aria-checked="true"/g)).length, 1)
  assert.equal(Array.from(html.matchAll(/aria-checked="false"/g)).length, 1)
  assert.match(html, /enable it to load on the next app launch/i)
}

function testManifestOnlyRowHasNoEnableControl(): void {
  const html = renderRow(
    moduleView('trusted', launch({ status: 'trusted_manifest_only', hasMainEntry: false })),
    { enabled: false }
  )
  assert.match(html, /Manifest only/)
  assert.ok(!html.includes('Load on the next app launch'), 'no enable control when there is no code to run')
  assert.equal(countSwitches(html), 1, 'only the trust switch')
  assert.ok(!html.includes('Launch error'), 'manifest-only is not an error')
}

function testBlockedRowShowsOffSwitchAndNoEnableControl(): void {
  const html = renderRow(moduleView('unsigned', launch({ status: 'blocked_unsigned' })))
  assert.ok(html.includes('Unsigned'), 'trust label text shown (non-color-only)')
  assert.equal(countSwitches(html), 1, 'untrusted module exposes no enable control yet')
  assert.ok(html.includes('aria-checked="false"'), 'untrusted module reads as off')
  assert.ok(!html.includes('Load on the next app launch'))
  assert.match(html, /Blocked until trusted/)
}

function testInvalidRowHasNoToggles(): void {
  const html = renderRow(moduleView('invalid', launch({ status: 'blocked_invalid' })))
  assert.equal(countSwitches(html), 0, 'invalid signature exposes no trust or enable toggle')
  assert.ok(html.includes('Cannot be trusted'), 'invalid signature is stated, not color-only')
  assert.match(html, /invalid signature/i)
}

function testPendingRowDisablesTheTrustSwitch(): void {
  const html = renderRow(moduleView('signed', launch({ status: 'blocked_signed' })), { pending: true })
  assert.ok(html.includes('role="switch"'), 'switch present while pending')
  assert.ok(html.includes('disabled'), 'trust switch is disabled while a trust change is in flight')
}

function testPermissionChipsDiscloseTiersAndFlagBroadAndUnknown(): void {
  const html = renderRow(
    moduleView('trusted', launch({}), {
      permissions: ['ipc:agents', 'ipc:invoke', 'totally-made-up'],
    }),
    { enabled: true }
  )
  // Tiered scope renders its consent description without a warning tint.
  assert.ok(html.includes('Launch and control agents and terminals'), 'tier description shown')
  // The broad scope is retained but flagged: wording + warn tint. The assertion
  // is on the words, not the tint — the guarantee is that the flag is never
  // color-only, so it must survive any wording the copy settles on.
  assert.match(html, /broad scope/i, 'the broad scope is named in copy, not color-only')
  assert.ok(html.includes('tone-warn'), 'broad/unknown chips carry the warn tint')
  // Unknown scopes surface verbatim as unrecognized (forward-compatible).
  assert.ok(html.includes('Unrecognized capability: totally-made-up'))
  // Disclosure framing: nothing in the row claims enforcement.
  assert.doesNotMatch(html, /sandbox|enforced/i)
}

function testLaunchErrorRowSurfacesTheRealError(): void {
  const html = renderRow(
    moduleView('trusted', launch({ status: 'launch_error', message: 'entry escaped module root' })),
    { enabled: true }
  )
  assert.match(html, /Launch error/)
  assert.ok(html.includes('entry escaped module root'), 'real startup error is surfaced')
}

function testDescribeRendererEntryMapsSourcesAndSession(): void {
  // No declared entry, and trust-blocked modules, render no renderer line: the
  // trust row already carries one "blocked until trusted" signal.
  assert.equal(describeRendererEntry(undefined, undefined, 'trusted'), null)
  assert.equal(describeRendererEntry({ availability: 'none' }, undefined, 'trusted'), null)
  assert.equal(describeRendererEntry({ availability: 'blocked' }, undefined, 'unsigned'), null)
  assert.equal(describeRendererEntry({ availability: 'available' }, undefined, 'unsigned'), null)

  // Main-reported serving failure (contained-but-broken bundle).
  const serving = describeRendererEntry(
    { availability: 'error', message: 'entry.renderer bundle file is missing.' },
    undefined,
    'trusted'
  )
  assert.equal(serving?.label, 'Renderer entry error')
  assert.equal(serving.detail, 'entry.renderer bundle file is missing.')

  // Servable but not evaluated this session (e.g. trusted after boot) reads as
  // next-launch, mirroring main-entry semantics.
  const ready = describeRendererEntry({ availability: 'available' }, undefined, 'trusted')
  assert.equal(ready?.label, 'Renderer entry ready')
  assert.match(ready.detail, /next app launch/i)

  // Loaded this session: contributions follow the toggle live.
  const loaded = describeRendererEntry({ availability: 'available' }, { status: 'loaded' }, 'trusted')
  assert.equal(loaded?.label, 'Renderer entry loaded')
  assert.match(loaded.detail, /without a reload/i)

  // This session's import/registration failure surfaces its sanitized message.
  const failed = describeRendererEntry(
    { availability: 'available' },
    { status: 'error', message: 'registerRenderer threw: boom' },
    'trusted'
  )
  assert.equal(failed?.label, 'Renderer entry failed')
  assert.equal(failed.detail, 'registerRenderer threw: boom')
}

function testRendererOnlyModuleRowIsNotManifestOnly(): void {
  const html = renderRow(
    moduleView('trusted', {
      status: 'trusted_manifest_only',
      hasMainEntry: false,
      expectedToLoad: false,
      rendererEntry: { availability: 'available' },
    }),
    { enabled: true, rendererLoadState: { status: 'loaded' } }
  )
  // "Manifest only — no code to run" would be false for this shape.
  assert.doesNotMatch(html, /Manifest only/)
  assert.match(html, /Renderer entry loaded/)
  // The renderer-only module gets a live enable affordance.
  assert.equal(countSwitches(html), 2, 'trust switch + enable switch')
  assert.ok(html.includes('Enable contributions'))
}

function testRendererEntryFailureRowIsolatesTheError(): void {
  const html = renderRow(
    moduleView('trusted', {
      status: 'trusted_manifest_only',
      hasMainEntry: false,
      expectedToLoad: false,
      rendererEntry: { availability: 'available' },
    }),
    { enabled: true, rendererLoadState: { status: 'error', message: 'boom at import time' } }
  )
  assert.match(html, /Renderer entry failed/)
  assert.ok(html.includes('boom at import time'), 'renderer load error is surfaced verbatim (sanitized upstream)')
}

function testDualEntryRowNamesBothHalves(): void {
  const html = renderRow(
    moduleView('trusted', {
      status: 'trusted_executable',
      hasMainEntry: true,
      expectedToLoad: true,
      rendererEntry: { availability: 'available' },
    }),
    { enabled: true, rendererLoadState: { status: 'loaded' } }
  )
  // Both execution surfaces visible, each named, plus one enable control.
  assert.match(html, /Main entry ready/)
  assert.match(html, /Renderer entry loaded/)
  assert.ok(html.includes('Enable this module'))
  assert.equal(countSwitches(html), 2)
}

function testBlockedRendererOnlyModuleStaysBlockedTextOnly(): void {
  const html = renderRow(
    moduleView('unsigned', {
      status: 'blocked_unsigned',
      hasMainEntry: false,
      expectedToLoad: false,
      rendererEntry: { availability: 'blocked', message: 'Renderer entry is blocked until the module is trusted.' },
    })
  )
  assert.match(html, /Blocked until trusted/)
  // Exactly one blocked signal: no second renderer-entry line, no enable toggle.
  assert.doesNotMatch(html, /Renderer entry/)
  assert.equal(countSwitches(html), 1, 'only the trust switch')
}

// G3. The row carries an Uninstall control exactly when the host gives it a
// handler — a build whose preload predates the uninstall channel shows no
// button rather than one that reports an error when pressed. It is offered for
// every trust state, including an invalid signature (the state where removing
// it is the ONLY thing left to do), and it goes flat while another action on
// the same row is in flight.
function testUninstallControlAppearsOnlyWithAHandler(): void {
  const view = moduleView('trusted', launch({ status: 'trusted_executable' }))
  const without = renderRow(view)
  assert.doesNotMatch(without, /Uninstall/, 'no handler, no control')

  const withHandler = renderRow(view, { onUninstall: () => {} })
  assert.match(withHandler, /Uninstall/)
  assert.match(withHandler, /aria-label="Uninstall Demo Module"/)
  // The two switches the row already had are untouched by it.
  assert.equal(countSwitches(withHandler), countSwitches(without))

  const invalid = renderRow(moduleView('invalid', launch({ status: 'blocked_invalid', expectedToLoad: false })), {
    onUninstall: () => {},
  })
  assert.match(invalid, /Uninstall/, 'an invalid module is the one you most need to remove')

  const pending = renderRow(view, { pending: true, onUninstall: () => {} })
  assert.match(pending, /aria-label="Uninstall Demo Module"[^>]*disabled|disabled[^>]*aria-label="Uninstall Demo Module"/)
}

const tests = [
  testDescribeLaunchMapsEveryStatus,
  testUninstallControlAppearsOnlyWithAHandler,
  testResolveModuleEnabledPrefersOverrideThenDefault,
  testTrustedExecutableEnabledRow,
  testTrustedExecutableDisabledRowIsNotADeadEnd,
  testManifestOnlyRowHasNoEnableControl,
  testBlockedRowShowsOffSwitchAndNoEnableControl,
  testInvalidRowHasNoToggles,
  testPendingRowDisablesTheTrustSwitch,
  testPermissionChipsDiscloseTiersAndFlagBroadAndUnknown,
  testLaunchErrorRowSurfacesTheRealError,
  testDescribeRendererEntryMapsSourcesAndSession,
  testRendererOnlyModuleRowIsNotManifestOnly,
  testRendererEntryFailureRowIsolatesTheError,
  testDualEntryRowNamesBothHalves,
  testBlockedRendererOnlyModuleStaysBlockedTextOnly,
]

let failures = 0
for (const test of tests) {
  try {
    test()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${test.name}`)
    console.error(error)
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} test group(s) passed`)
