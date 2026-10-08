// @vitest-environment jsdom
//
// Settings ▸ Version control opens on the page header every other tab draws,
// not on a section title standing in for one.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { VersionControlSections } from './SettingsPanel'

function render(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<VersionControlSections githubToken={null} />)
  return host
}

test('the tab opens on the shared page header, carrying the re-check control', () => {
  const host = render()
  const headings = [...host.querySelectorAll('h3')].map((heading) => heading.textContent)
  expect(headings[0]).toBe('Version control')
  // The title is not said twice: the first band is labelled by the header.
  expect(headings.filter((text) => text === 'Version control')).toHaveLength(1)
  const header = host.querySelector('#version-control-page')!.parentElement!
  expect(header.querySelector('[aria-label="Re-check now"]')).not.toBeNull()
})

test('the later band keeps a section title of its own', () => {
  const host = render()
  const sections = host.querySelectorAll('section')
  expect(sections[0].getAttribute('aria-labelledby')).toBe('version-control-page')
  const forge = host.querySelector(`#${sections[1].getAttribute('aria-labelledby')}`)
  expect(forge?.textContent).toContain('Source control providers')
})
