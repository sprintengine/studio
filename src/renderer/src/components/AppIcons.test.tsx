import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { Workspace } from '../types/workspace'
import { WorkspaceTypeIcon, resolveEnabledWorkspaceType } from './AppIcons'

// Distinctive path fragment per bundled mode's canonical glyph, so the test pins
// icon identity rather than just "an svg renders".
const EXPECTED_ICON_PATH: Record<string, string> = {
  standard: 'M7.25 10L10 12.5L7.25 15',
  switchboard: 'M9 5.5V18.5M15 5.5V18.5',
  sprintengine: 'M10.85 8.2L7.65 14.35',
  multiloop: 'M12 4.5 A7.5 7.5 0 0 1 19.5 12',
  'guided-brief': 'M5 6.25C5 5.42',
}

function iconHtml(mode: Workspace['mode']): string {
  return renderToStaticMarkup(<WorkspaceTypeIcon mode={mode} className="icon-sm" />)
}

// AC2: without moduleOverrides (ungated) each bundled mode renders its canonical
// icon, and the generic/standard glyph backs standard + unknown ids.
for (const [mode, path] of Object.entries(EXPECTED_ICON_PATH)) {
  assert.ok(iconHtml(mode as Workspace['mode']).includes(path), `${mode} renders its canonical icon`)
}
assert.ok(
  iconHtml('future-plugin-mode' as Workspace['mode']).includes(EXPECTED_ICON_PATH.standard),
  'unknown mode id renders the generic standard icon without throwing',
)

// AC4: with moduleOverrides disabling the module, WorkspaceTypeIcon degrades to
// the generic standard glyph instead of the type's icon.
const sprintEngineOffIcon = renderToStaticMarkup(
  <WorkspaceTypeIcon mode="sprintengine" moduleOverrides={{ 'sprint-engine': false }} className="icon-sm" />,
)
assert.ok(sprintEngineOffIcon.includes(EXPECTED_ICON_PATH.standard), 'disabled sprint-engine renders the generic glyph')
assert.ok(!sprintEngineOffIcon.includes(EXPECTED_ICON_PATH.sprintengine), 'disabled sprint-engine drops the sprintengine glyph')
const sprintEngineOnIcon = renderToStaticMarkup(
  <WorkspaceTypeIcon mode="sprintengine" moduleOverrides={{}} className="icon-sm" />,
)
assert.ok(sprintEngineOnIcon.includes(EXPECTED_ICON_PATH.sprintengine), 'enabled sprint-engine renders its glyph')

// AC4 tab icon-shape degradation + re-enable recovery for the multiloop tab
// (its wrapper is neutral, so only the icon shape degrades).
const multiloopOffIcon = renderToStaticMarkup(
  <WorkspaceTypeIcon mode="multiloop" moduleOverrides={{ multiloop: false }} className="icon-sm" />,
)
assert.ok(multiloopOffIcon.includes(EXPECTED_ICON_PATH.standard), 'disabled multiloop tab renders the generic glyph')
assert.ok(!multiloopOffIcon.includes(EXPECTED_ICON_PATH.multiloop), 'disabled multiloop tab drops the multiloop glyph')
const multiloopOnIcon = renderToStaticMarkup(
  <WorkspaceTypeIcon mode="multiloop" moduleOverrides={{ multiloop: true }} className="icon-sm" />,
)
assert.ok(multiloopOnIcon.includes(EXPECTED_ICON_PATH.multiloop), 're-enabled multiloop tab restores its glyph')

// AC4: enablement gating — a disabled module resolves to no definition, so the
// caller degrades to the generic icon/default accent. resolveEnabledWorkspaceType
// is the pure seam both WorkspaceTypeIcon and workspaceTabIconClass use.
const allEnabled: ModuleEnablementOverrides = {}
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.id, 'sprintengine')
assert.equal(resolveEnabledWorkspaceType('switchboard', allEnabled)?.id, 'switchboard')
assert.equal(resolveEnabledWorkspaceType('multiloop', allEnabled)?.accentToken, '--text-muted')
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.accentToken, '--tool-sprintengine')
assert.equal(resolveEnabledWorkspaceType('standard', allEnabled), undefined, 'standard is shell-owned, not registered')
assert.equal(resolveEnabledWorkspaceType('future-x' as Workspace['mode'], allEnabled), undefined, 'unknown id resolves to undefined')

assert.equal(
  resolveEnabledWorkspaceType('sprintengine', { 'sprint-engine': false }),
  undefined,
  'disabled sprint-engine module resolves to no definition (generic degradation)',
)
assert.equal(
  resolveEnabledWorkspaceType('multiloop', { multiloop: false }),
  undefined,
  'disabled multiloop module resolves to no definition',
)
// guided-brief is registered under the sprint-engine module, so disabling
// sprint-engine also degrades guided-brief.
assert.equal(
  resolveEnabledWorkspaceType('guided-brief', { 'sprint-engine': false }),
  undefined,
  'disabling sprint-engine also degrades guided-brief',
)

// AC1: top-bar view set lives on the registry. Only Multiloop contributes one
// (verbatim from the former VIEWS_FOR_MODE); Sprint Engine and Switchboard do
// not, and a disabled module exposes none.
const multiloopViews = resolveEnabledWorkspaceType('multiloop', allEnabled)?.topBarViews
assert.deepEqual(multiloopViews, { label: 'Multiloop', views: [{ component: 'multiloop-board', name: 'Multiloop' }] })
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.topBarViews, undefined, 'sprintengine has no top-bar views')
assert.equal(resolveEnabledWorkspaceType('switchboard', allEnabled)?.topBarViews, undefined, 'switchboard has no top-bar views')
assert.equal(resolveEnabledWorkspaceType('multiloop', { multiloop: false })?.topBarViews, undefined, 'disabled multiloop exposes no views')

console.log('workspace type icon tests passed')
