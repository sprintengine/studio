#!/usr/bin/env node
// Acceptance check for @multicode/module-sdk:
// 1. The package builds standalone and `npm pack` produces a tarball.
// 2. The packed d.ts public surface contains no `any`.
// 3. The committed external fixture project compiles against the tarball
//    types only, including public provider-registration exports.
// 4. The host-bridged subpaths (`/ui`, `/surface`) resolve as published entry
//    points, and a module bundled with the documented externals keeps them as
//    bare imports for the host's import map to answer (D6).

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
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
for (const forbiddenExport of ['AutomationsProviderRegistryToken', 'AutomationsProviderRegistry']) {
  if (publicTypes.includes(forbiddenExport)) {
    throw new Error(`SDK public surface exposes forbidden raw Automations registry contract: ${forbiddenExport}.`)
  }
}
console.log('public surface contains no `any`')

run(`npm install --no-save --no-package-lock --no-audit --no-fund ../${tarball}`, fixtureDir)

// The bridged subpaths must be reachable the way a module author reaches them:
// through the INSTALLED package's `exports` map, with declarations behind it.
const installedDir = join(fixtureDir, 'node_modules', '@multicode', 'module-sdk')
const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
for (const subpath of ['./ui', './surface']) {
  const entry = installedManifest.exports?.[subpath]
  if (!entry?.types || !entry?.default) {
    throw new Error(`packed @multicode/module-sdk does not export "${subpath}".`)
  }
  for (const relative of [entry.types, entry.default]) {
    if (!existsSync(join(installedDir, relative))) {
      throw new Error(`packed @multicode/module-sdk exports "${subpath}" → ${relative}, which the tarball does not ship.`)
    }
  }
}
console.log('bridged subpaths ./ui and ./surface resolve from the tarball')

// Typechecks src/ui-bridge.ts among the rest: components from both subpaths
// and `DiffEditor` from `@monaco-editor/react`, written as a module author
// would write them.
run('npx tsc -p tsconfig.json', fixtureDir)

// The other half of the contract: bundled with the documented externals, none
// of the host-provided specifiers may be inlined — the throwing stub must
// never reach a module's bundle, and the bare imports must survive for the
// host's import map to answer.
const HOST_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@monaco-editor/react',
  '@multicode/module-sdk/ui',
  '@multicode/module-sdk/surface',
]
const bundlePath = join(fixtureDir, 'ui-bridge.bundle.mjs')
run(
  `npx esbuild src/ui-bridge.ts --bundle --format=esm --platform=browser ` +
    `${HOST_EXTERNALS.map((specifier) => `--external:${specifier}`).join(' ')} ` +
    `--outfile=${bundlePath}`,
  fixtureDir
)
const bundle = readFileSync(bundlePath, 'utf8')
rmSync(bundlePath, { force: true })
for (const specifier of ['@multicode/module-sdk/ui', '@multicode/module-sdk/surface', '@monaco-editor/react']) {
  if (!new RegExp(`from ?["']${specifier.replace(/[/@]/g, '\\$&')}["']`).test(bundle)) {
    throw new Error(`bundling the fixture did not leave "${specifier}" as a bare import.`)
  }
}
if (bundle.includes('is provided by the host at runtime')) {
  throw new Error('the throwing runtime stub was inlined into the module bundle despite --external.')
}
console.log('a module bundled with the documented externals keeps the bridged specifiers bare')

console.log('module-sdk pack verification passed')
