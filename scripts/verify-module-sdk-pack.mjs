#!/usr/bin/env node
// Acceptance check for @multicode/module-sdk:
// 1. The package builds standalone and `npm pack` produces a tarball.
// 2. The packed d.ts public surface contains no `any`.
// 3. The committed external fixture project compiles against the tarball
//    types only, including public provider-registration exports.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const sdkDir = join(repoRoot, 'packages', 'module-sdk')
const fixtureDir = join(sdkDir, 'test-fixtures', 'external-project')

const run = (command, cwd) => {
  console.log(`$ ${command}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

run('npx tsc -p tsconfig.json', sdkDir)

const packOutput = execSync('npm pack --pack-destination test-fixtures', { cwd: sdkDir })
  .toString('utf8')
  .trim()
const tarball = packOutput.split('\n').at(-1)
if (!tarball?.endsWith('.tgz')) {
  throw new Error(`npm pack did not report a tarball (got "${tarball}").`)
}
console.log(`packed ${tarball}`)

const publicTypes = readFileSync(join(sdkDir, 'dist', 'index.d.ts'), 'utf8')
const anyUses = publicTypes.match(/\bany\b/g) ?? []
if (anyUses.length > 0) {
  throw new Error(`SDK public surface contains ${anyUses.length} use(s) of \`any\`.`)
}
console.log('public surface contains no `any`')

run(`npm install --no-save --no-package-lock --no-audit --no-fund ../${tarball}`, fixtureDir)
run('npx tsc -p tsconfig.json', fixtureDir)

console.log('module-sdk pack verification passed')
