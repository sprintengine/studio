import assert from 'node:assert/strict'
import { buildPastedImageDescriptor } from './pasteAttachment'

const fixedDate = new Date('2026-05-14T19:34:56.789Z')

const pngFile = new File(['png-bytes'], 'pasted.png', { type: 'image/png' })
const pngDescriptor = buildPastedImageDescriptor({
  workspaceRoot: '/workspace',
  inspirationDirectoryPath: '/workspace/.guided-brief/inspiration',
  file: pngFile,
  now: fixedDate,
})
assert.match(pngDescriptor.relativePath, /^\.guided-brief\/inspiration\/2026-05-14T19-34-56Z-[0-9a-f]+\.png$/)
assert.equal(pngDescriptor.absolutePath, `/workspace/.guided-brief/inspiration/${pngDescriptor.filename}`)
assert.equal(pngDescriptor.id, pngDescriptor.filename)
assert.equal(pngDescriptor.mimeType, 'image/png')

const jpegFile = new File(['jpeg-bytes'], 'pasted.jpg', { type: 'image/jpeg' })
const jpegDescriptor = buildPastedImageDescriptor({
  workspaceRoot: '/workspace',
  inspirationDirectoryPath: '/workspace/.guided-brief/inspiration',
  file: jpegFile,
  now: fixedDate,
})
assert.ok(jpegDescriptor.relativePath.endsWith('.jpg'), 'jpeg files keep the .jpg extension')

const webpFile = new File(['webp-bytes'], 'pasted.webp', { type: 'image/webp' })
const webpDescriptor = buildPastedImageDescriptor({
  workspaceRoot: '/workspace',
  inspirationDirectoryPath: '/workspace/.guided-brief/inspiration',
  file: webpFile,
  now: fixedDate,
})
assert.ok(webpDescriptor.relativePath.endsWith('.webp'), 'webp files keep the .webp extension')

const winFile = new File(['png-bytes'], 'pasted.png', { type: 'image/png' })
const winDescriptor = buildPastedImageDescriptor({
  workspaceRoot: 'C:\\workspace',
  inspirationDirectoryPath: 'C:\\workspace\\.guided-brief\\inspiration',
  file: winFile,
  now: fixedDate,
})
assert.ok(winDescriptor.absolutePath.startsWith('C:\\workspace\\.guided-brief\\inspiration\\'), 'absolute path uses backslash separators on Windows-like roots')
assert.match(winDescriptor.relativePath, /^\.guided-brief\/inspiration\//, 'project-relative path always uses forward slashes')
