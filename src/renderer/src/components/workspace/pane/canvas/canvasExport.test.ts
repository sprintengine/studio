import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CANVAS_EXPORT_DEFAULT_FORMATS, canvasExportFileNames, canvasExportedToast } from './canvasExport'

test('an export writes only the board file unless a picture is asked for', () => {
  assert.deepEqual(CANVAS_EXPORT_DEFAULT_FORMATS, { png: false, svg: false })
  assert.deepEqual(canvasExportFileNames('arch', CANVAS_EXPORT_DEFAULT_FORMATS), ['arch.excalidraw'])
})

test('the pictures follow the board file, named after the board', () => {
  assert.deepEqual(canvasExportFileNames('arch', { png: true, svg: true }), ['arch.excalidraw', 'arch.png', 'arch.svg'])
  assert.deepEqual(canvasExportFileNames('arch', { png: false, svg: true }), ['arch.excalidraw', 'arch.svg'])
})

test('the toast names the files by name and the folder in full', () => {
  assert.deepEqual(
    canvasExportedToast({
      directory: '/Users/dev/project/docs',
      files: ['/Users/dev/project/docs/arch.excalidraw'],
    }),
    { title: 'Board exported', description: 'arch.excalidraw in /Users/dev/project/docs' },
  )
  assert.deepEqual(
    canvasExportedToast({
      directory: 'C:\\Users\\dev\\project',
      files: ['C:\\Users\\dev\\project\\arch.excalidraw', 'C:\\Users\\dev\\project\\arch.png'],
    }),
    { title: 'Board exported with 1 image', description: 'arch.excalidraw, arch.png in C:\\Users\\dev\\project' },
  )
  assert.equal(
    canvasExportedToast({ directory: '/d', files: ['/d/a.excalidraw', '/d/a.png', '/d/a.svg'] }).title,
    'Board exported with 2 images',
  )
})
