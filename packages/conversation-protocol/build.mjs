import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const packageDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
rmSync(join(packageDir, 'dist'), { recursive: true, force: true })
for (const project of ['tsconfig.json', 'tsconfig.cjs.json']) {
  execFileSync(process.execPath, [compiler, '-p', project], { cwd: packageDir, stdio: 'inherit' })
}
for (const [directory, type] of [['esm', 'module'], ['cjs', 'commonjs']]) {
  const target = join(packageDir, 'dist', directory)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type })}\n`, 'utf8')
}
