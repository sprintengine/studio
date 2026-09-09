import assert from 'node:assert/strict'
import React from 'react'

import { DiffBody } from './DiffViewer'
import { DEFAULT_DIFF_EDITOR_PREFS, diffEditorOptions } from './diffToolbarModel'
import type { DiffFileItem } from './diffFileList'

// "Toggling the view does not remount Monaco" (git-commit-window T4,
// acceptance 2), asserted where React actually decides it.
//
// React remounts a child when the ELEMENT's `type` or `key` changes, and for
// nothing else — new props on the same type are an update. `DiffBody` holds no
// hooks precisely so this suite can call it as a plain function and read the
// element it returns, rather than driving a real Monaco (which needs a loader,
// a canvas and a network fetch, none of which exist in a unit test). The
// companion assertion lives in `diffToolbarModel.test.ts`: every preference is
// in the live option set, so a change to one is always an `updateOptions` call.

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

const item: DiffFileItem = {
  path: '/repo/src/a.ts',
  relativePath: 'src/a.ts',
  status: 'modified',
  kind: 'unstaged',
}

function bodyFor(diffView: 'side-by-side' | 'unified', hideUnchanged = false): React.ReactElement {
  const element = DiffBody({
    content: { state: 'ready', original: 'a\n', modified: 'b\n', language: 'typescript' },
    repoState: 'ready',
    currentItem: item,
    onMount: () => {},
    monacoTheme: 'vs',
    options: diffEditorOptions(
      { diffView, ...DEFAULT_DIFF_EDITOR_PREFS, hideUnchanged },
      'mono',
    ),
  })
  assert.ok(React.isValidElement(element), 'a ready diff renders an element')
  return element as React.ReactElement
}

run('the view toggle changes props, not the element identity', () => {
  const side = bodyFor('side-by-side')
  const unified = bodyFor('unified')
  assert.equal(side.type, unified.type, 'the same component type — anything else is a remount')
  assert.equal(side.key, null, 'no key at all, so no key can change under the editor')
  assert.equal(unified.key, null)
})

run('the content the editor is showing is untouched by a view change', () => {
  const side = bodyFor('side-by-side')
  const unified = bodyFor('unified')
  // The wrapper creates new models when these change, so a toggle that altered
  // one would be a remount by another name.
  for (const prop of ['original', 'modified', 'language'] as const) {
    assert.equal(
      (side.props as Record<string, unknown>)[prop],
      (unified.props as Record<string, unknown>)[prop],
      `${prop} must not move with the view`,
    )
  }
  assert.equal((side.props as Record<string, unknown>).keepCurrentOriginalModel, true)
  assert.equal((side.props as Record<string, unknown>).keepCurrentModifiedModel, true)
})

run('the toggle does reach the editor — the options carry it', () => {
  const side = bodyFor('side-by-side')
  const unified = bodyFor('unified')
  const options = (element: React.ReactElement): Record<string, unknown> =>
    (element.props as Record<string, unknown>).options as Record<string, unknown>
  assert.equal(options(side).renderSideBySide, true)
  assert.equal(options(unified).renderSideBySide, false)
  assert.deepEqual(options(bodyFor('unified', true)).hideUnchangedRegions, { enabled: true })
})

run('the states before a diff are still plain messages, with no editor at all', () => {
  const loading = DiffBody({
    content: { state: 'loading' },
    repoState: 'ready',
    currentItem: item,
    onMount: () => {},
    monacoTheme: 'vs',
    options: diffEditorOptions({ diffView: 'side-by-side', ...DEFAULT_DIFF_EDITOR_PREFS }, 'mono'),
  })
  assert.ok(React.isValidElement(loading))
  assert.notEqual((loading as React.ReactElement).type, bodyFor('side-by-side').type)
})

if (failures > 0) {
  console.error(`${failures} failing`)
  process.exit(1)
}
console.log('DiffViewerRemount.test.tsx: ok')
