import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { Workspace } from '../types/workspace'
import { FolderTypeIcon, WorkspaceTypeIcon, resolveEnabledWorkspaceType } from './AppIcons'
import { test } from 'vitest'

test('AppIcons', async () => {
  // Distinctive path fragment per bundled mode's canonical glyph, so the test pins
  // icon identity rather than just "an svg renders".
  const EXPECTED_ICON_PATH: Record<string, string> = {
    standard: 'M7.25 10L10 12.5L7.25 15',
    // The automations host's dial-and-bolt mark, from its own module.
    'automations-host': 'M19.5 12a7.5 7.5 0 1 1-3.4-6.28',
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
  const automationsOffIcon = renderToStaticMarkup(
    <WorkspaceTypeIcon mode="automations-host" moduleOverrides={{ automations: false }} className="icon-sm" />,
  )
  assert.ok(automationsOffIcon.includes(EXPECTED_ICON_PATH.standard), 'a disabled module renders the generic glyph')
  assert.ok(
    !automationsOffIcon.includes(EXPECTED_ICON_PATH['automations-host']),
    'a disabled module drops its own glyph',
  )
  const automationsOnIcon = renderToStaticMarkup(
    <WorkspaceTypeIcon mode="automations-host" moduleOverrides={{}} className="icon-sm" />,
  )
  assert.ok(automationsOnIcon.includes(EXPECTED_ICON_PATH['automations-host']), 'an enabled module renders its glyph')

  // AC4: enablement gating — a disabled module resolves to no definition, so the
  // caller degrades to the generic icon/default accent. resolveEnabledWorkspaceType
  // is the pure seam both WorkspaceTypeIcon and workspaceTabIconClass use.
  const allEnabled: ModuleEnablementOverrides = {}
  assert.equal(resolveEnabledWorkspaceType('automations-host', allEnabled)?.id, 'automations-host')
  assert.equal(resolveEnabledWorkspaceType('automations-host', allEnabled)?.accentToken, '--accent-primary')
  assert.equal(
    resolveEnabledWorkspaceType('standard', allEnabled),
    undefined,
    'standard is shell-owned, not registered',
  )
  assert.equal(
    resolveEnabledWorkspaceType('future-x' as Workspace['mode'], allEnabled),
    undefined,
    'unknown id resolves to undefined',
  )

  assert.equal(
    resolveEnabledWorkspaceType('automations-host', { automations: false }),
    undefined,
    'a disabled module resolves to no definition (generic degradation)',
  )

  // AC1: top-bar view sets live on the registry; no bundled type contributes one
  // today, and a disabled module exposes none.
  assert.equal(
    resolveEnabledWorkspaceType('automations-host', allEnabled)?.topBarViews,
    undefined,
    'automations-host has no top-bar views',
  )

  // Re-sited by the owner on 2026-09-02: the FOLDER header's icon slot
  // carries the project's own logo when its repo has one, and every way out of
  // that lands back on the plain folder glyph. Workspace rows carry no logo — and
  // since that change, no icon at all.
  const LOGO_SRC = 'data:image/svg+xml;base64,PHN2Zy8+'
  const FOLDER_GLYPH_PATH =
    'M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z'
  const withLogo = renderToStaticMarkup(<FolderTypeIcon className="icon-sm" logoSrc={LOGO_SRC} />)
  assert.ok(withLogo.includes(`src="${LOGO_SRC}"`), 'a detected logo renders in the folder icon slot')
  assert.ok(withLogo.includes('icon-sm'), 'the logo keeps the slot geometry the glyph would have had')
  assert.ok(withLogo.includes('rounded-[var(--radius-xs)]'), 'the logo carries the chip radius')
  assert.ok(withLogo.includes('aria-hidden="true"'), 'the logo is decorative, like the glyph it replaces')
  assert.ok(!withLogo.includes(FOLDER_GLYPH_PATH), 'the folder glyph steps aside for the logo')
  assert.ok(
    renderToStaticMarkup(<FolderTypeIcon className="icon-sm" logoSrc={null} />).includes(FOLDER_GLYPH_PATH),
    'no logo renders exactly the folder glyph',
  )
  assert.ok(
    renderToStaticMarkup(<FolderTypeIcon className="icon-sm" />).includes(FOLDER_GLYPH_PATH),
    'an undetected folder renders exactly the folder glyph',
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
      root.render(<FolderTypeIcon className="icon-sm" logoSrc="data:image/png;base64,not-an-image" />)
    })

    const image = container.querySelector('img')
    assert.ok(image, 'the logo is attempted first')
    await act(async () => {
      image!.dispatchEvent(new dom.window.Event('error'))
    })

    assert.equal(container.querySelector('img'), null, 'a logo that fails to load leaves no broken-image box')
    assert.ok(
      container.innerHTML.includes(FOLDER_GLYPH_PATH),
      'a logo that fails to load degrades to the plain folder glyph',
    )

    await act(async () => {
      root.unmount()
    })
  }

  const suiteRun = main()
    .then(() => console.log('workspace type icon tests passed'))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })

  await suiteRun
})
