import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'vitest'

// The package's main entry runs in a browser as well as in Node, so nothing it
// reaches may import a Node built-in; the Node-only half is `./node`.

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
const NODE = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

test('nothing the main entry reaches imports a Node built-in', () => {
  const start = resolve(__dirname, '..', 'src', 'index.ts')
  const seen = new Set<string>([start])
  const queue = [start]
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index]
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1]
      assert.equal(NODE.has(specifier), false, `${file} imports ${specifier}`)
      if (!specifier.startsWith('.')) continue
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ''))
      const target = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate))
      if (target && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  // The walk reaches through the protocol packages' sources, so they are held to it too.
  assert.ok([...seen].some((file) => file.includes(join('studio-protocol', 'src'))))
  assert.ok([...seen].some((file) => file.includes(join('conversation-protocol', 'src'))))
})
