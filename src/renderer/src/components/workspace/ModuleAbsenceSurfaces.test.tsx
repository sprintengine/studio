import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DoorModuleNotInstalledSurface,
  MissingModulePanelSurface,
  ModuleNotInstalledSurface,
  marketplaceModuleEntry,
  marketplaceModuleForComponent,
  moduleLabelForMode,
  moduleLabelForModuleId,
  workspaceModuleAbsence,
} from './ModuleAbsenceSurfaces'
import { test } from 'vitest'

test('ModuleAbsenceSurfaces', async () => {
  // MC-1532 absence surfaces: the workspace-level and per-tab "module not
  // installed" states. Rendered statically (the same way the settings-row tests
  // render) so copy, labeling, and the install affordance are pinned without a
  // DOM; the marketplace mapping is pure and tested directly.

  const PLUGINS = [
    { id: 'calendar', name: 'Calendar', provides: ['module' as const] },
    { id: 'current-docs-mcp', name: 'Current Docs', provides: ['mcp' as const] },
  ]

  function testMarketplaceMappingRequiresModuleKindAndPrefix(): void {
    assert.deepEqual(
      marketplaceModuleForComponent('calendar.board', PLUGINS),
      { id: 'calendar', name: 'Calendar' },
      'a namespaced component id maps through its module prefix',
    )
    assert.equal(
      marketplaceModuleForComponent('current-docs-mcp.panel', PLUGINS),
      null,
      'a marketplace entry that does not provide a module never claims a tab',
    )
    assert.equal(marketplaceModuleForComponent('calendar', PLUGINS), null, 'un-namespaced ids stay generic')
    assert.equal(marketplaceModuleForComponent('.hidden', PLUGINS), null)
    assert.equal(marketplaceModuleForComponent('unknown.panel', PLUGINS), null)
    assert.equal(
      marketplaceModuleForComponent('calendar.board', PLUGINS, () => true),
      null,
      'a stale panel id of a PRESENT module never claims the module is missing',
    )
    assert.deepEqual(
      marketplaceModuleForComponent('calendar.board', PLUGINS, () => false),
      { id: 'calendar', name: 'Calendar' },
      'an absent module still maps',
    )
  }

  function testNotInstalledSurfaceNamesTheModuleAndOffersInstall(): void {
    const html = renderToStaticMarkup(<ModuleNotInstalledSurface label="Calendar" onOpenMarketplace={() => {}} />)
    assert.match(html, /Calendar isn’t installed/)
    assert.match(html, /safe on disk/, 'the surface says the data is untouched')
    assert.match(html, /Find it in Plugins/, 'the install affordance is present')
    assert.match(html, /aria-label="Module not installed"/)
  }

  function testMissingPanelSurfaceFallsBackUntilResolved(): void {
    // Statically rendered (no effects run, and no window.api exists here), the
    // tab keeps the caller's generic fallback — an unknown/stale tab never
    // pretends to be an installable module.
    const html = renderToStaticMarkup(
      <MissingModulePanelSurface
        componentId="calendar.board"
        fallback={<div aria-label="Panel unavailable" />}
        onOpenMarketplace={() => {}}
      />,
    )
    assert.match(html, /aria-label="Panel unavailable"/)
    assert.doesNotMatch(html, /isn’t installed/)
  }

  function testModeLabelFallsBackToCapitalizedId(): void {
    assert.equal(moduleLabelForMode('calendar'), 'Calendar')
  }

  // MC-1854: the door-level absence surface — door name, one sentence, one CTA
  // into Extensions — with copy that stays honest between "not installed" and
  // "installed but disabled".
  function testDoorNotInstalledSurfaceNamesTheDoorAndOffersExtensions(): void {
    const html = renderToStaticMarkup(<DoorModuleNotInstalledSurface label="Reviews" onOpenExtensions={() => {}} />)
    assert.match(html, /Reviews/)
    assert.match(html, /The Reviews module isn’t installed\./)
    assert.match(html, /Find it in Plugins/, 'the single CTA is present')
    assert.match(html, /aria-label="Door module not installed"/)

    const disabled = renderToStaticMarkup(
      <DoorModuleNotInstalledSurface label="Reviews" installed onOpenExtensions={() => {}} />,
    )
    assert.match(disabled, /The Reviews module is turned off\./)
    assert.doesNotMatch(disabled, /isn’t installed\./, 'a disabled module is never called uninstalled')
  }

  // G9. Which registry entry a missing door's module id resolves to. An entry
  // under the same id that ships no module is not it: installing that would put
  // something on the machine that cannot open the door the person is standing at.
  function testMarketplaceModuleEntryRequiresAModuleComponent(): void {
    assert.deepEqual(marketplaceModuleEntry('calendar', PLUGINS), PLUGINS[0])
    assert.equal(marketplaceModuleEntry('current-docs-mcp', PLUGINS), null, 'an mcp-only entry never installs a door')
    assert.equal(
      marketplaceModuleEntry('review', PLUGINS),
      null,
      'an id the registry does not carry resolves to nothing',
    )
    assert.equal(marketplaceModuleEntry('   ', PLUGINS), null)
    assert.deepEqual(marketplaceModuleEntry('  calendar  ', PLUGINS), PLUGINS[0], 'a padded id still resolves')
  }

  // G9. The door offers a real Install when the registry carries a module entry
  // for the missing id — but only once the registry has ANSWERED. Rendered
  // statically no effect runs, so the door keeps the signpost it always had,
  // which is also what a machine with no marketplace gets.
  function testDoorSurfaceKeepsTheSignpostUntilTheRegistryAnswers(): void {
    const html = renderToStaticMarkup(
      <DoorModuleNotInstalledSurface label="Reviews" moduleId="review" onOpenExtensions={() => {}} />,
    )
    assert.match(html, /Find it in Plugins/)
    assert.doesNotMatch(html, /Install Reviews/, 'no button is drawn on a registry that has not answered')
  }

  // A module that is on the machine and switched off is a Settings toggle, never
  // an install: the surface must not ask the registry about it at all, so the
  // door for a disabled module keeps exactly one CTA.
  function testDisabledDoorNeverOffersInstall(): void {
    const html = renderToStaticMarkup(
      <DoorModuleNotInstalledSurface label="Reviews" moduleId="review" installed onOpenExtensions={() => {}} />,
    )
    assert.match(html, /The Reviews module is turned off\./)
    assert.doesNotMatch(html, /Install Reviews/)
    assert.match(html, /Find it in Plugins/)
  }

  // MC-2577. A persisted workspace whose type IS registered but whose module is
  // switched off: the module is on the machine, so the copy must say turned off
  // rather than not installed, and the action must lead to the toggle rather than
  // a storefront.
  function testTurnedOffWorkspaceSurfaceSaysSoAndLeadsToTheToggle(): void {
    const html = renderToStaticMarkup(
      <ModuleNotInstalledSurface
        label="Automations"
        installed
        actionLabel="Open module settings"
        onOpenMarketplace={() => {}}
      />,
    )
    assert.match(html, /Automations is turned off/)
    assert.match(html, /turn the module back on/, 'the body names the remedy')
    assert.match(html, /Open module settings/, 'the enable affordance replaces the storefront signpost')
    assert.doesNotMatch(html, /Find it in Plugins/)
  }

  // A workspace type id and its owning module id need not match — a module may
  // register a type under a name of its own — so the turned-off surface reads the
  // label off the MODULE id, not the mode.
  function testModuleIdLabelNamesTheBundledModule(): void {
    assert.equal(moduleLabelForModuleId('automations'), 'Automations')
    assert.equal(moduleLabelForModuleId('tide-tables'), 'tide-tables', 'an id no manifest knows is returned as-is')
  }

  // MC-2577. The rule behind the surface above. A registered workspace type owned
  // by a module that is switched off must produce the turned-off answer rather
  // than letting the layout mount — and turning it back on must produce no answer
  // at all.
  function testWorkspaceAbsenceAnswersInstalledAbsentAndDisabled(): void {
    const deps = (enabled: boolean, registered = true) => ({
      isBundledHiddenMode: (mode: string) => mode === 'automations-host',
      workspaceTypeModuleId: (mode: string) => (registered && mode === 'tide-tables' ? 'tide-tables' : undefined),
      isModuleEnabled: () => enabled,
    })

    assert.equal(workspaceModuleAbsence('standard', deps(true)), null, 'the shell mode is never absent')
    assert.equal(
      workspaceModuleAbsence('automations-host', deps(false)),
      null,
      'a bundled hidden host is a background container, not a surface that can be absent',
    )
    assert.equal(
      workspaceModuleAbsence('tide-tables', deps(true)),
      null,
      'with the module on, the workspace renders its own layout',
    )
    assert.deepEqual(
      workspaceModuleAbsence('tide-tables', deps(false)),
      { kind: 'disabled', label: 'tide-tables', moduleId: 'tide-tables' },
      'a persisted workspace whose module is switched off opens on the turned-off surface',
    )
    assert.deepEqual(
      workspaceModuleAbsence('tide-tables', deps(true, false)),
      { kind: 'not-installed', label: 'Tide-tables' },
      'with nothing registering the type, the same workspace offers an install',
    )
  }

  testWorkspaceAbsenceAnswersInstalledAbsentAndDisabled()
  testTurnedOffWorkspaceSurfaceSaysSoAndLeadsToTheToggle()
  testModuleIdLabelNamesTheBundledModule()
  testMarketplaceMappingRequiresModuleKindAndPrefix()
  testMarketplaceModuleEntryRequiresAModuleComponent()
  testDoorSurfaceKeepsTheSignpostUntilTheRegistryAnswers()
  testDisabledDoorNeverOffersInstall()
  testNotInstalledSurfaceNamesTheModuleAndOffersInstall()
  testMissingPanelSurfaceFallsBackUntilResolved()
  testModeLabelFallsBackToCapitalizedId()
  testDoorNotInstalledSurfaceNamesTheDoorAndOffersExtensions()
  console.log('ModuleAbsenceSurfaces tests passed')
})
