// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { APP_THEMES } from '../../types/appTheme'
import AppThemePicker from './AppThemePicker'

test("a swatch's accent dot sits in a different corner from the scheme glyph", () => {
  const theme = APP_THEMES.find((entry) => entry.swatches)!
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<AppThemePicker value={theme.id} onChange={() => {}} />)
  const accent = [...host.querySelectorAll<HTMLElement>('span[style]')].find(
    (span) => span.className.includes('absolute') && span.style.backgroundColor !== '',
  )!
  expect(accent).toBeDefined()
  // The scheme glyph owns the lower right; the dot under it was hidden.
  expect(accent.className).not.toMatch(/\bbottom-/)
  expect(accent.className).toMatch(/\btop-2\b/)
})
