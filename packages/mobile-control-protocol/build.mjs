#!/usr/bin/env node
// Builds @sprintengine/mobile-control-protocol twice, into dist/esm and
// dist/cjs.
//
// Two builds because the two consumers load the module in two different ways
// and neither can be talked out of it. The desktop bundles ESM through
// electron-vite. The phone's app bundles through Metro, but its regression
// suite compiles with `module: Node16` and runs the output on bare Node, which
// reaches this package through `require`. A single ESM build would type-check
// there and then fail at `require` time, which is the worst place to find out.
//
// Each output directory gets its own one-line package.json naming its module
// kind. That marker is what makes `dist/cjs/index.js` CommonJS despite the root
// manifest saying `"type": "module"`, and it is also what makes TypeScript read
// `dist/cjs/index.d.ts` as CommonJS declarations under node16 resolution — so a
// consumer's `require` gets CJS types and its `import` gets ESM types, rather
// than one set of declarations lying to half the callers.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))

const tsc = (project) => {
  console.log(`$ tsc -p ${project}`)
  execFileSync('npx', ['tsc', '-p', project], { cwd: packageDir, stdio: 'inherit' })
}

rmSync(join(packageDir, 'dist'), { recursive: true, force: true })

tsc('tsconfig.json')
tsc('tsconfig.cjs.json')

for (const [directory, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  const target = join(packageDir, 'dist', directory)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`, 'utf8')
}

console.log('built dist/esm (module) and dist/cjs (commonjs)')
