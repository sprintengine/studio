import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'vitest'

// Server code runs where there is no Electron: a standalone Studio server, a
// WSL distribution, a remote box. So nothing reachable from src/server may
// import it, directly or through a file it imports. This walks the import
// graph from every source file here and fails on the first path to it, so the
// boundary is held by a test rather than by review.

const root = resolve(__dirname, '..', '..')
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) && !/\.test(-helper)?\.tsx?$/.test(entry) ? [path] : []
  })
}

function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return null
}

test('nothing reachable from src/server imports electron', () => {
  const seen = new Map<string, string | null>()
  const queue: Array<[file: string, parent: string | null]> = sources(join(root, 'src', 'server')).map((file) => [
    file,
    null,
  ])
  for (const [file, parent] of queue) seen.set(file, parent)
  for (let index = 0; index < queue.length; index++) {
    const [file] = queue[index]
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1]
      if (specifier === 'electron' || specifier.startsWith('electron/')) {
        const path: string[] = []
        for (let at: string | null | undefined = file; at; at = seen.get(at)) path.unshift(relative(root, at))
        assert.fail(`src/server reaches electron: ${path.join(' -> ')}`)
      }
      if (!specifier.startsWith('.')) continue
      const target = resolveImport(file, specifier)
      if (target && !seen.has(target)) {
        seen.set(target, file)
        queue.push([target, file])
      }
    }
  }
  assert.ok(queue.length > 5, 'the walk found the server sources')
})
