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
  // The frond's stem — SprintEngine's mode wears the product's own mark
  // (`brand/SprintEngineFrond`), the same one the mobile app carries.
  sprintengine: 'M 303.12,855.85',
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

// AC4: enablement gating — a disabled module resolves to no definition, so the
// caller degrades to the generic icon/default accent. resolveEnabledWorkspaceType
// is the pure seam both WorkspaceTypeIcon and workspaceTabIconClass use.
const allEnabled: ModuleEnablementOverrides = {}
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.id, 'sprintengine')
assert.equal(resolveEnabledWorkspaceType('switchboard', allEnabled)?.id, 'switchboard')
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.accentToken, '--tool-sprintengine')
assert.equal(resolveEnabledWorkspaceType('standard', allEnabled), undefined, 'standard is shell-owned, not registered')
assert.equal(resolveEnabledWorkspaceType('future-x' as Workspace['mode'], allEnabled), undefined, 'unknown id resolves to undefined')

assert.equal(
  resolveEnabledWorkspaceType('sprintengine', { 'sprint-engine': false }),
  undefined,
  'disabled sprint-engine module resolves to no definition (generic degradation)',
)
// guided-brief is owned by the design-wizard module (MC-1860), which declares
// dependsOn ['sprint-engine'] — disabling sprint-engine cascades through the
// enablement resolver and still degrades guided-brief.
assert.equal(
  resolveEnabledWorkspaceType('guided-brief', { 'sprint-engine': false }),
  undefined,
  'disabling sprint-engine also degrades guided-brief',
)

// AC1: top-bar view sets live on the registry; no bundled type contributes one
// today, and a disabled module exposes none.
assert.equal(resolveEnabledWorkspaceType('sprintengine', allEnabled)?.topBarViews, undefined, 'sprintengine has no top-bar views')
assert.equal(resolveEnabledWorkspaceType('switchboard', allEnabled)?.topBarViews, undefined, 'switchboard has no top-bar views')

// MC-2135: the icon slot carries the project's own logo when the repo has one,
// and every way out of that lands back on today's exact glyph.
const LOGO_SRC = 'data:image/svg+xml;base64,PHN2Zy8+'
const withLogo = renderToStaticMarkup(
  <WorkspaceTypeIcon mode="standard" className="icon-sm" logoSrc={LOGO_SRC} />,
)
assert.ok(withLogo.includes(`src="${LOGO_SRC}"`), 'a detected logo renders in the icon slot')
assert.ok(withLogo.includes('icon-sm'), 'the logo keeps the slot geometry the glyph would have had')
assert.ok(withLogo.includes('rounded-[var(--radius-xs)]'), 'the logo carries the chip radius')
assert.ok(withLogo.includes('aria-hidden="true"'), 'the logo is decorative, like the glyph it replaces')
assert.ok(!withLogo.includes(EXPECTED_ICON_PATH.standard), 'the glyph steps aside for the logo')
assert.ok(
  renderToStaticMarkup(<WorkspaceTypeIcon mode="standard" className="icon-sm" logoSrc={null} />)
    .includes(EXPECTED_ICON_PATH.standard),
  'no logo renders exactly the glyph',
)
assert.ok(
  renderToStaticMarkup(<WorkspaceTypeIcon mode="sprintengine" className="icon-sm" logoSrc={LOGO_SRC} />)
    .includes(`src="${LOGO_SRC}"`),
  'the logo replaces a type glyph too, not just the generic one',
)

// The load-failure fallback is behaviour, not markup: a data URI that will not
// decode must degrade to the glyph rather than leave a broken-image box. That
// needs a real DOM to fire the img error event, so this one test stands one up.
async function main(): Promise<void> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')

  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  await act(async () => {
    root.render(<WorkspaceTypeIcon mode="standard" className="icon-sm" logoSrc="data:image/png;base64,not-an-image" />)
  })

  const image = container.querySelector('img')
  assert.ok(image, 'the logo is attempted first')
  await act(async () => {
    image!.dispatchEvent(new dom.window.Event('error'))
  })

  assert.equal(container.querySelector('img'), null, 'a logo that fails to load leaves no broken-image box')
  assert.ok(
    container.innerHTML.includes(EXPECTED_ICON_PATH.standard),
    'a logo that fails to load degrades to today exact glyph',
  )

  await act(async () => {
    root.unmount()
  })
}

main()
  .then(() => console.log('workspace type icon tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
