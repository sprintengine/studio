// Builds dist/esm and dist/cjs.
//
// The protocol is a dependency of this package, not a copy of it. In this
// repository `src/protocol.ts` re-exports the Studio protocol's source by path,
// so the app's tests drive this client against the server they ship with. The
// build stages the sources with that one file replaced by a re-export of
// `@sprintengine/studio-protocol`, and compiles the staged tree against the
// protocol packages' own declarations, so the tarball names its dependency.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const packageDir = dirname(fileURLToPath(import.meta.url))
const packagesDir = join(packageDir, '..')
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const stage = join(packageDir, '.stage')

// The protocol's build builds the conversation protocol it depends on first.
execFileSync(process.execPath, [join(packagesDir, 'studio-protocol', 'build.mjs')], { stdio: 'inherit' })
rmSync(join(packageDir, 'dist'), { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
try {
  cpSync(join(packageDir, 'src'), join(stage, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  })
  writeFileSync(join(stage, 'src', 'protocol.ts'), "export * from '@sprintengine/studio-protocol'\n")
  for (const [directory, module, type] of [
    ['esm', 'ES2022', 'module'],
    ['cjs', 'CommonJS', 'commonjs'],
  ]) {
    const project = join(stage, `tsconfig.${directory}.json`)
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module,
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noImplicitAny: true,
          declaration: true,
          outDir: join(packageDir, 'dist', directory),
          rootDir: join(stage, 'src'),
          skipLibCheck: true,
          types: ['node'],
          typeRoots: [join(packagesDir, '..', 'node_modules', '@types')],
          paths: {
            '@sprintengine/studio-protocol': [join(packagesDir, 'studio-protocol', 'dist', directory, 'public.d.ts')],
            '@sprintengine/conversation-protocol': [
              join(packagesDir, 'conversation-protocol', 'dist', directory, 'public.d.ts'),
            ],
          },
        },
        include: [join(stage, 'src')],
      }),
    )
    execFileSync(process.execPath, [compiler, '-p', project], { cwd: stage, stdio: 'inherit' })
    const target = join(packageDir, 'dist', directory)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type })}\n`, 'utf8')
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
