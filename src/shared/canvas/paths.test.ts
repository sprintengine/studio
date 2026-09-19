import assert from 'node:assert/strict'

import {
  CANVAS_DEFAULT_FOLDER,
  DEFAULT_CANVAS_BOARD_PATH,
  canvasBoardKeyPath,
  canvasBoardName,
  canvasPathIsCaseInsensitive,
  normalizeCanvasPath,
} from './paths'
import { test } from 'vitest'

test('paths', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function accepted(input: string): string {
    const result = normalizeCanvasPath(input)
    assert.equal(result.ok, true, `expected ${input} to be accepted`)
    return result.ok ? result.value : ''
  }

  function rejected(input: string): string {
    const result = normalizeCanvasPath(input)
    assert.equal(result.ok, false, `expected ${input} to be refused`)
    if (result.ok) return ''
    assert.equal(result.error.code, 'invalid_path')
    return result.error.message
  }

  run('normalizeCanvasPath accepts the four spellings a caller uses', () => {
    const table: Array<[string, string]> = [
      ['arch', 'diagrams/arch.excalidraw'],
      ['arch.excalidraw', 'diagrams/arch.excalidraw'],
      ['diagrams/arch.excalidraw', 'diagrams/arch.excalidraw'],
      ['docs/x/flow.excalidraw', 'docs/x/flow.excalidraw'],
      ['docs/x/flow', 'docs/x/flow.excalidraw'],
      ['  arch  ', 'diagrams/arch.excalidraw'],
      ['./diagrams/arch.excalidraw', 'diagrams/arch.excalidraw'],
      ['diagrams//arch.excalidraw', 'diagrams/arch.excalidraw'],
    ]
    for (const [input, expected] of table) assert.equal(accepted(input), expected, input)
  })

  run('normalizeCanvasPath folds a Windows separator to posix', () => {
    assert.equal(accepted('docs\\x\\flow.excalidraw'), 'docs/x/flow.excalidraw')
    assert.equal(accepted('diagrams\\arch'), 'diagrams/arch.excalidraw')
  })

  run('normalizeCanvasPath is idempotent', () => {
    const once = accepted('arch')
    assert.equal(accepted(once), once)
  })

  run('normalizeCanvasPath refuses anything that could leave the project', () => {
    const table = [
      '',
      '   ',
      '/etc/passwd',
      '/diagrams/arch.excalidraw',
      'C:/diagrams/arch.excalidraw',
      'c:\\diagrams\\arch.excalidraw',
      '../secrets.excalidraw',
      'diagrams/../../secrets.excalidraw',
      '.git/arch.excalidraw',
      'node_modules/pkg/arch.excalidraw',
      'a/node_modules/arch.excalidraw',
      '.excalidraw',
      'notes.md',
      'arch.json',
      'arch.excalidraw.bak',
    ]
    for (const input of table) assert.ok(rejected(input).length > 0, input)
  })

  run('normalizeCanvasPath refuses a NUL byte', () => {
    const message = rejected(`arch${String.fromCharCode(0)}.excalidraw`)
    assert.match(message, /NUL/)
  })

  run('canvasBoardName strips the folder and the extension', () => {
    assert.equal(canvasBoardName('diagrams/arch.excalidraw'), 'arch')
    assert.equal(canvasBoardName('docs/x/flow.excalidraw'), 'flow')
    assert.equal(canvasBoardName('arch'), 'arch')
  })

  run('the default board sits in the default folder', () => {
    assert.equal(DEFAULT_CANVAS_BOARD_PATH, `${CANVAS_DEFAULT_FOLDER}/canvas.excalidraw`)
    assert.equal(accepted('canvas'), DEFAULT_CANVAS_BOARD_PATH)
  })

  run('the forbidden folders are refused however they are spelled', () => {
    // Two of the three platforms read `.GIT` and `.git` as one folder, so a guard
    // that only catches the lower-case spelling is a guard a caller walks around.
    for (const input of ['.GIT/arch.excalidraw', '.Git/arch.excalidraw', 'Node_Modules/pkg/arch.excalidraw']) {
      assert.match(rejected(input), /must not lead through/, input)
    }
  })

  run('the extension is accepted in any case, and never respelled', () => {
    assert.equal(accepted('diagrams/Arch.EXCALIDRAW'), 'diagrams/Arch.EXCALIDRAW')
    assert.equal(accepted('diagrams/arch.Excalidraw'), 'diagrams/arch.Excalidraw')
    assert.ok(rejected('.EXCALIDRAW').length > 0, 'the extension alone is still not a name')
  })

  run('a board key folds the case exactly where the filesystem does', () => {
    assert.equal(canvasPathIsCaseInsensitive('darwin'), true)
    assert.equal(canvasPathIsCaseInsensitive('win32'), true)
    assert.equal(canvasPathIsCaseInsensitive('linux'), false)

    const upper = 'diagrams/Arch.excalidraw'
    const lower = 'diagrams/arch.excalidraw'
    assert.equal(canvasBoardKeyPath(upper, 'darwin'), canvasBoardKeyPath(lower, 'darwin'))
    assert.notEqual(canvasBoardKeyPath(upper, 'linux'), canvasBoardKeyPath(lower, 'linux'))
    assert.equal(canvasBoardKeyPath(upper, 'linux'), upper, 'the key is the path itself where case counts')
  })

  console.log('canvas paths tests passed')
})
