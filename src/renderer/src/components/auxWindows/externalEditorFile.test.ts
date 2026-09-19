import assert from 'node:assert/strict'

import { createExternalFileTab, isExternalFileBufferDirty, loadExternalFileBuffer } from './externalEditorFile'

void main()

async function main(): Promise<void> {
  testClassifiesSvgAsImage()
  await testImageFilesUseImageDataUrlReader()
  await testTextFilesUseTextReaderAndDirtyTracking()
  await testImageLoadErrorsDoNotFallBackToTextReader()

  console.log('externalEditorFile.test.ts: ok')
}

function testClassifiesSvgAsImage(): void {
  assert.deepEqual(createExternalFileTab({ path: '/workspace/logo.svg', name: 'logo.svg', workspaceId: 'ws-1' }), {
    path: '/workspace/logo.svg',
    name: 'logo.svg',
    workspaceId: 'ws-1',
    kind: 'image',
  })
}

async function testImageFilesUseImageDataUrlReader(): Promise<void> {
  const calls: string[] = []
  const buffer = await loadExternalFileBuffer('/workspace/logo.svg', 'image', {
    async readfile() {
      calls.push('readfile')
      throw new Error('readfile should not be called for images')
    },
    async readImageDataUrl(path) {
      calls.push(`readImageDataUrl:${path}`)
      return 'data:image/svg+xml;base64,PHN2Zy8+'
    },
  })

  assert.deepEqual(calls, ['readImageDataUrl:/workspace/logo.svg'])
  assert.deepEqual(buffer, {
    kind: 'image',
    dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
    loading: false,
    error: null,
  })
  assert.equal(isExternalFileBufferDirty(buffer), false)
}

async function testTextFilesUseTextReaderAndDirtyTracking(): Promise<void> {
  const calls: string[] = []
  const buffer = await loadExternalFileBuffer('/workspace/notes.md', 'text', {
    async readfile(path) {
      calls.push(`readfile:${path}`)
      return '# Notes'
    },
    async readImageDataUrl() {
      calls.push('readImageDataUrl')
      throw new Error('readImageDataUrl should not be called for text')
    },
  })

  assert.deepEqual(calls, ['readfile:/workspace/notes.md'])
  assert.deepEqual(buffer, {
    kind: 'text',
    value: '# Notes',
    saved: '# Notes',
    loading: false,
    error: null,
  })
  assert.equal(buffer.kind, 'text')
  assert.equal(isExternalFileBufferDirty(buffer), false)
  assert.equal(isExternalFileBufferDirty({ ...buffer, value: '# Changed' }), true)
}

async function testImageLoadErrorsDoNotFallBackToTextReader(): Promise<void> {
  const calls: string[] = []
  const buffer = await loadExternalFileBuffer('/workspace/photo.png', 'image', {
    async readfile() {
      calls.push('readfile')
      return 'fake text'
    },
    async readImageDataUrl() {
      calls.push('readImageDataUrl')
      throw new Error('Unsupported image file type.')
    },
  })

  assert.deepEqual(calls, ['readImageDataUrl'])
  assert.deepEqual(buffer, {
    kind: 'image',
    dataUrl: null,
    loading: false,
    error: 'Unsupported image file type.',
  })
}
