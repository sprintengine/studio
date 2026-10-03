// Builds dist/esm and dist/cjs.
//
// The timeline is a dependency of this package, not a copy of it. In this
// repository `src/timeline.ts` re-exports the timeline's source by path; the
// build stages the sources with that one file replaced by a re-export of
// `@sprintengine/conversation-timeline`, and compiles the staged tree against
// the timeline package's own declarations, so the tarball names its dependency.
// React is a peer, read from this repository's own types.
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

execFileSync(process.execPath, [join(packagesDir, 'conversation-timeline', 'build.mjs')], { stdio: 'inherit' })
rmSync(join(packageDir, 'dist'), { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
try {
  cpSync(join(packageDir, 'src'), join(stage, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts') && !source.endsWith('.test.tsx'),
  })
  writeFileSync(join(stage, 'src', 'timeline.ts'), "export * from '@sprintengine/conversation-timeline'\n")
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
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          jsx: 'react-jsx',
          strict: true,
          noImplicitAny: true,
          declaration: true,
          outDir: join(packageDir, 'dist', directory),
          rootDir: join(stage, 'src'),
          skipLibCheck: true,
          types: [],
          typeRoots: [join(packagesDir, '..', 'node_modules', '@types')],
          paths: {
            '@sprintengine/conversation-timeline': [
              join(packagesDir, 'conversation-timeline', 'dist', directory, 'public.d.ts'),
            ],
            '@sprintengine/conversation-protocol': [
              join(packagesDir, 'conversation-protocol', 'dist', directory, 'public.d.ts'),
            ],
            react: [join(packagesDir, '..', 'node_modules', '@types', 'react')],
            'react/jsx-runtime': [join(packagesDir, '..', 'node_modules', '@types', 'react', 'jsx-runtime.d.ts')],
            'react-dom': [join(packagesDir, '..', 'node_modules', '@types', 'react-dom')],
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
