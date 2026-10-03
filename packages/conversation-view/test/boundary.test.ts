import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The view is published on its own (phase 9 spec, 5.1): it imports React, its
// own files and the timeline, and nothing of Studio's app (no `window.api`, no
// store, no renderer module). The timeline imports only its own files and the
// conversation protocol, with no React, DOM or Electron.

function imports(directory: string): Array<[string, string]> {
  const found: Array<[string, string]> = []
  for (const file of readdirSync(directory)) {
    if (!/\.tsx?$/u.test(file)) continue
    const source = readFileSync(join(directory, file), 'utf8')
    for (const match of source.matchAll(/from '([^']+)'/gu)) found.push([file, match[1]])
    if (/window\.api\b/u.test(source)) found.push([file, 'window.api'])
  }
  return found
}

test('the view reaches React, its own files and the timeline, and nothing of the app', () => {
  const outside = imports(join(__dirname, '..', 'src')).filter(
    ([, specifier]) =>
      !['react', 'react-dom'].includes(specifier) &&
      !/^\.\/[\w.-]+\.js$/u.test(specifier) &&
      specifier !== '../../conversation-timeline/src/public.js',
  )
  expect(outside).toEqual([])
})

test('the timeline reaches its own files and the conversation protocol only', () => {
  const outside = imports(join(__dirname, '..', '..', 'conversation-timeline', 'src')).filter(
    ([, specifier]) =>
      !/^\.\/[\w.-]+\.js$/u.test(specifier) && specifier !== '../../conversation-protocol/src/public.js',
  )
  expect(outside).toEqual([])
})
