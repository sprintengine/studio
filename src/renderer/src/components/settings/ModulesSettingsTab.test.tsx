// Settings → Modules: how the bundled categories lay out. The third-party list
// below them talks to the main process and is not what is under test.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

import { MODULE_CATEGORY_GROUPS, categoryLabel } from './ModuleControls'
import { ModulesSettingsTab } from './ModulesSettingsTab'

vi.mock('./ThirdPartyModuleList', () => ({ ThirdPartyModuleList: () => null }))

function render(): string {
  return renderToStaticMarkup(<ModulesSettingsTab />)
}

function listFor(markup: string, label: string): string {
  const start = markup.indexOf(`<ul aria-label="${label.replaceAll('&', '&amp;')}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  return markup.slice(start, markup.indexOf('>', start))
}

test('a category of one module takes one column, not two with an empty half', () => {
  const single = MODULE_CATEGORY_GROUPS.find((group) => group.manifests.length === 1)
  expect(single).toBeDefined()
  const markup = render()
  expect(listFor(markup, categoryLabel(single!.category))).not.toContain('grid-cols-2')
})

test('a category of several modules keeps two columns', () => {
  const several = MODULE_CATEGORY_GROUPS.find((group) => group.manifests.length > 1)
  expect(several).toBeDefined()
  const markup = render()
  expect(listFor(markup, categoryLabel(several!.category))).toContain('sm:grid-cols-2')
})

test('module summaries wrap to two lines instead of clipping to one', () => {
  const markup = render()
  const summary = MODULE_CATEGORY_GROUPS[0].manifests[0].summary
  const at = markup.indexOf(`>${summary}<`)
  expect(at).toBeGreaterThan(0)
  const open = markup.lastIndexOf('<span', at)
  expect(markup.slice(open, at)).toContain('line-clamp-2')
  expect(markup.slice(open, at)).not.toMatch(/\btruncate\b/)
})
