import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { ProjectSourceMenu } from './ProjectSourceMenu'

// The project selector's sources step 1 (remote-sessions-ux /
// project-selector-sources). The Git step's behaviour is the shipped MC-2207
// machinery, pinned by test:renderer:github-clone; what this file pins is the
// selector's own anatomy.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const markup = renderToStaticMarkup(
  <ProjectSourceMenu
    options={[
      { path: '/w/multicode', label: 'multicode' },
      { path: '/w/quickscan', label: 'quickscan' },
    ]}
    selectedPath="/w/multicode"
    defaultParent="/w"
    onSelect={() => {}}
    onBrowse={() => {}}
    onClose={() => {}}
  />
)

run('the selector opens on a search field over the project rows', () => {
  assert.match(markup, /aria-label="Search projects"/)
  const search = markup.indexOf('Search projects')
  const firstRow = markup.indexOf('multicode')
  assert.ok(search !== -1 && firstRow !== -1 && search < firstRow, 'search leads the list')
})

run('project rows are stacked menu items: name over mono path, selection by bg.selected', () => {
  assert.match(markup, /role="menuitemradio" aria-checked="true"/)
  assert.match(markup, /font-mono/, 'the path reads in the mono voice')
  assert.match(markup, /--bg-selected/, 'the choice wears the neutral selection wash')
})

run('the sources sit under a separator: Browse… and Import from Git as menu items', () => {
  assert.match(markup, /role="separator"/)
  assert.match(markup, /Browse…/)
  assert.match(markup, /Import from Git/)
  const separator = markup.indexOf('role="separator"')
  const browse = markup.indexOf('Browse…')
  assert.ok(separator < browse, 'sources are pinned under the projects')
})

run('a host without a folder dialog gets no Browse… row, and Import stays', () => {
  const noBrowse = renderToStaticMarkup(
    <ProjectSourceMenu
      options={[]}
      selectedPath={null}
      defaultParent={null}
      onSelect={() => {}}
      onClose={() => {}}
    />
  )
  assert.doesNotMatch(noBrowse, /Browse…/)
  assert.match(noBrowse, /Import from Git/)
  assert.match(noBrowse, /No matching projects\./)
})

if (failures > 0) {
  console.error(`ProjectSourceMenu.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ProjectSourceMenu.test.tsx: ok')
