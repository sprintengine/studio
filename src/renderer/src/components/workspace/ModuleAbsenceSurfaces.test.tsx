import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  MissingModulePanelSurface,
  ModuleNotInstalledSurface,
  marketplaceModuleForComponent,
  moduleLabelForMode,
} from './ModuleAbsenceSurfaces'

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
    'a namespaced component id maps through its module prefix'
  )
  assert.equal(
    marketplaceModuleForComponent('current-docs-mcp.panel', PLUGINS),
    null,
    'a marketplace entry that does not provide a module never claims a tab'
  )
  assert.equal(marketplaceModuleForComponent('calendar', PLUGINS), null, 'un-namespaced ids stay generic')
  assert.equal(marketplaceModuleForComponent('.hidden', PLUGINS), null)
  assert.equal(marketplaceModuleForComponent('unknown.panel', PLUGINS), null)
}

function testNotInstalledSurfaceNamesTheModuleAndOffersInstall(): void {
  const html = renderToStaticMarkup(
    <ModuleNotInstalledSurface label="Calendar" onOpenMarketplace={() => {}} />
  )
  assert.match(html, /Calendar isn’t installed/)
  assert.match(html, /safe on disk/, 'the surface says the data is untouched')
  assert.match(html, /Find it in Connectors/, 'the install affordance is present')
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
    />
  )
  assert.match(html, /aria-label="Panel unavailable"/)
  assert.doesNotMatch(html, /isn’t installed/)
}

function testModeLabelFallsBackToCapitalizedId(): void {
  assert.equal(moduleLabelForMode('calendar'), 'Calendar')
}

testMarketplaceMappingRequiresModuleKindAndPrefix()
testNotInstalledSurfaceNamesTheModuleAndOffersInstall()
testMissingPanelSurfaceFallsBackUntilResolved()
testModeLabelFallsBackToCapitalizedId()
console.log('ModuleAbsenceSurfaces tests passed')
