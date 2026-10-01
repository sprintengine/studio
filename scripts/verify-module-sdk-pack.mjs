#!/usr/bin/env node
// Acceptance check for @sprintengine/module-sdk:
// 1. The package builds standalone and `npm pack` produces a tarball.
// 2. The packed d.ts public surface contains no `any`.
// 3. The committed external fixture project compiles against the tarball
//    types only, including public provider-registration exports.
// 4. Every entry point in the `exports` map resolves from the tarball, every
//    name it exports can be imported through the package, and no exported
//    declaration leans on a type the package does not export.
// 5. The host-bridged subpaths (`/ui`, `/surface`) stay bare imports when a
//    module is bundled with the documented externals, for the host's import
//    map to answer (D6).

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const sdkDir = join(repoRoot, 'packages', 'module-sdk')
const fixtureDir = join(sdkDir, 'test-fixtures', 'external-project')

const run = (command, cwd) => {
  console.log(`$ ${command}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

// `build` clears dist first, so a source file that was deleted or moved can
// never ship as a stale declaration.
run('npm run build', sdkDir)

const packOutput = execSync('npm pack --pack-destination test-fixtures', { cwd: sdkDir }).toString('utf8').trim()
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

// Every entry point must be reachable the way a module author reaches it:
// through the INSTALLED package's `exports` map, with declarations and code
// behind it. The bridged subpaths are required by name as well.
const installedDir = join(fixtureDir, 'node_modules', '@sprintengine', 'module-sdk')
const installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
const entryPoints = Object.entries(installedManifest.exports ?? {})
for (const subpath of ['.', './ui', './surface']) {
  if (!installedManifest.exports?.[subpath]) {
    throw new Error(`packed @sprintengine/module-sdk does not export "${subpath}".`)
  }
}
for (const [subpath, entry] of entryPoints) {
  if (!entry?.types || !entry?.default) {
    throw new Error(`packed @sprintengine/module-sdk exports "${subpath}" without both types and default.`)
  }
  for (const relative of [entry.types, entry.default]) {
    if (!existsSync(join(installedDir, relative))) {
      throw new Error(
        `packed @sprintengine/module-sdk exports "${subpath}" → ${relative}, which the tarball does not ship.`,
      )
    }
  }
}
console.log(`every entry point resolves from the tarball: ${entryPoints.map(([subpath]) => subpath).join(', ')}`)

// A declaration the emitted .d.ts keeps without `export` is one an exported
// declaration refers to (tsc drops the rest), so it is a type a module author
// meets in a signature and cannot name. The published surface has none.
const installedDist = join(installedDir, 'dist')
const unexported = []
for (const file of readdirSync(installedDist).filter((name) => name.endsWith('.d.ts'))) {
  const source = readFileSync(join(installedDist, file), 'utf8')
  for (const match of source.matchAll(
    /^(?:declare )?(?:abstract class|class|const|enum|function|interface|let|namespace|type|var) ([A-Za-z_$][\w$]*)/gm,
  )) {
    unexported.push(`${file}: ${match[1]}`)
  }
}
if (unexported.length > 0) {
  throw new Error(`the published surface refers to types it does not export:\n  ${unexported.join('\n  ')}`)
}
console.log('every type the published surface refers to is exported')

// The names each entry point declares, read off its emitted declarations,
// following the `export { … } from './x.js'` re-exports the root index uses.
const declaredNames = (file) => {
  const source = readFileSync(file, 'utf8')
  if (/^export \* from/m.test(source)) {
    throw new Error(`${file} uses \`export *\`; list the names so this check can see them.`)
  }
  const names = [
    ...source.matchAll(
      /^export (?:declare )?(?:abstract class|class|const|enum|function|interface|let|namespace|type|var) ([A-Za-z_$][\w$]*)/gm,
    ),
  ].map((match) => match[1])
  for (const match of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const specifier of match[1].split(',')) {
      const name = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)
      if (name) names.push(name)
    }
  }
  return [...new Set(names)].sort()
}

// Import every one of those names through the package specifier a module
// author writes, and compile it with the fixture below: a name that the
// declarations list but the `exports` map does not reach fails here.
const probePath = join(fixtureDir, 'src', 'export-probe.ts')
let probedNames = 0
const probeImports = entryPoints.map(([subpath, entry]) => {
  const specifier = subpath === '.' ? '@sprintengine/module-sdk' : `@sprintengine/module-sdk/${subpath.slice(2)}`
  const names = declaredNames(join(installedDir, entry.types))
  if (subpath === '.' && names.length === 0) throw new Error('the root entry point declares no exports.')
  probedNames += names.length
  return names.length > 0 ? `import type { ${names.join(', ')} } from '${specifier}'` : ''
})
writeFileSync(
  probePath,
  `// Generated by scripts/verify-module-sdk-pack.mjs; removed after the check.\n${probeImports.filter(Boolean).join('\n')}\n`,
)

// Typechecks src/ui-bridge.ts among the rest: components from both subpaths
// and `DiffEditor` from `@monaco-editor/react`, written as a module author
// would write them. Also compiles the export probe written above.
try {
  run('npx tsc -p tsconfig.json', fixtureDir)
} finally {
  rmSync(probePath, { force: true })
}
console.log(`every exported name (${probedNames}) imports through its entry point`)

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
  '@sprintengine/module-sdk/ui',
  '@sprintengine/module-sdk/surface',
]
const bundlePath = join(fixtureDir, 'ui-bridge.bundle.mjs')
run(
  `npx esbuild src/ui-bridge.ts --bundle --format=esm --platform=browser ` +
    `${HOST_EXTERNALS.map((specifier) => `--external:${specifier}`).join(' ')} ` +
    `--outfile=${bundlePath}`,
  fixtureDir,
)
const bundle = readFileSync(bundlePath, 'utf8')
rmSync(bundlePath, { force: true })
for (const specifier of ['@sprintengine/module-sdk/ui', '@sprintengine/module-sdk/surface', '@monaco-editor/react']) {
  if (!new RegExp(`from ?["']${specifier.replace(/[/@]/g, '\\$&')}["']`).test(bundle)) {
    throw new Error(`bundling the fixture did not leave "${specifier}" as a bare import.`)
  }
}
if (bundle.includes('is provided by the host at runtime')) {
  throw new Error('the throwing runtime stub was inlined into the module bundle despite --external.')
}
console.log('a module bundled with the documented externals keeps the bridged specifiers bare')

console.log('module-sdk pack verification passed')
