// Builds dist/esm and dist/cjs.
//
// The conversation contract is a dependency of this package, not a copy of it.
// In this repository `src/conversation.ts` re-exports the conversation
// package's source by path, so the app, its tests and this package compile
// against one tree. The build stages the sources with that one file replaced
// by a re-export of `@sprintengine/conversation-protocol`, and compiles the
// staged tree against that package's own declarations, so the tarball names
// the dependency instead of carrying a second copy of it.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const packageDir = dirname(fileURLToPath(import.meta.url))
const dependencyDir = join(packageDir, '..', 'conversation-protocol')
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const stage = join(packageDir, '.stage')

execFileSync(process.execPath, [join(dependencyDir, 'build.mjs')], { stdio: 'inherit' })
rmSync(join(packageDir, 'dist'), { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
try {
  cpSync(join(packageDir, 'src'), join(stage, 'src'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  })
  writeFileSync(join(stage, 'src', 'conversation.ts'), "export * from '@sprintengine/conversation-protocol'\n")
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
          strict: true,
          noImplicitAny: true,
          declaration: true,
          outDir: join(packageDir, 'dist', directory),
          rootDir: join(stage, 'src'),
          skipLibCheck: true,
          types: [],
          paths: {
            '@sprintengine/conversation-protocol': [join(dependencyDir, 'dist', directory, 'public.d.ts')],
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
