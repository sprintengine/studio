import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  bundledNpmCliPath,
  bundledPythonPath,
  managedNodeBinary,
  managedNodeEnv,
  managedPythonSpawnEnv,
  reportManagedPythonResolution,
  resolveManagedPython,
  withManagedRuntimePath,
  type ResolvedPython,
  type RuntimeEnv,
} from './managed-runtime'

function makeEnv(overrides: Partial<RuntimeEnv> & { present?: string[] } = {}): RuntimeEnv {
  const present = new Set(overrides.present ?? [])
  return {
    platform: overrides.platform ?? 'linux',
    resourcesPath: overrides.resourcesPath ?? '/app/resources',
    isPackaged: overrides.isPackaged ?? true,
    execPath: overrides.execPath ?? '/app/multicode',
    cwd: overrides.cwd ?? '/checkout',
    pythonOverride: overrides.pythonOverride,
    exists: overrides.exists ?? ((p: string) => present.has(p)),
  }
}

// --- bundled CPython discovery ---------------------------------------------

{
  const posixBundle = join('/app/resources', 'runtime', 'python', 'bin', 'python3')
  const env = makeEnv({ present: [posixBundle] })
  assert.equal(bundledPythonPath(env), posixBundle, 'finds posix bundled python under resourcesPath')
}

{
  const winBundle = join('C:\\res', 'runtime', 'python', 'python.exe')
  const env = makeEnv({ platform: 'win32', resourcesPath: 'C:\\res', present: [winBundle] })
  assert.equal(bundledPythonPath(env), winBundle, 'finds windows bundled python.exe')
}

{
  const env = makeEnv({ present: [] })
  assert.equal(bundledPythonPath(env), null, 'returns null when no bundled python present')
}

{
  // Dev (unpackaged) checkout falls back to <cwd>/resources.
  const devBundle = join('/checkout', 'resources', 'runtime', 'python', 'bin', 'python3')
  const env = makeEnv({ isPackaged: false, resourcesPath: undefined, present: [devBundle] })
  assert.equal(bundledPythonPath(env), devBundle, 'dev build finds python under <cwd>/resources')
}

{
  // Packaged build must NOT reach into the dev checkout path.
  const devBundle = join('/checkout', 'resources', 'runtime', 'python', 'bin', 'python3')
  const env = makeEnv({ isPackaged: true, resourcesPath: '/app/resources', present: [devBundle] })
  assert.equal(bundledPythonPath(env), null, 'packaged build ignores <cwd>/resources fallback')
}

// --- resolution precedence -------------------------------------------------

{
  const bundle = join('/app/resources', 'runtime', 'python', 'bin', 'python3')
  const venv = join('/repo', '.venv', 'bin', 'python')
  const env = makeEnv({ pythonOverride: '/custom/python', present: [bundle, venv] })
  const resolved = resolveManagedPython(env, '/repo')
  assert.equal(resolved.command, '/custom/python', 'override wins over everything')
  assert.equal(resolved.source, 'override')
}

{
  const bundle = join('/app/resources', 'runtime', 'python', 'bin', 'python3')
  const venv = join('/repo', '.venv', 'bin', 'python')
  const env = makeEnv({ present: [bundle, venv] })
  const resolved = resolveManagedPython(env, '/repo')
  assert.equal(resolved.command, bundle, 'bundled wins over venv')
  assert.equal(resolved.source, 'bundled')
}

{
  const venv = join('/repo', '.venv', 'bin', 'python')
  const env = makeEnv({ present: [venv] })
  const resolved = resolveManagedPython(env, '/repo')
  assert.equal(resolved.command, venv, 'venv used when no bundle and repoRoot given')
  assert.equal(resolved.source, 'venv')
}

{
  const env = makeEnv({ present: [] })
  const resolved = resolveManagedPython(env, '/repo')
  assert.equal(resolved.command, 'python3', 'falls back to system python3 on posix')
  assert.equal(resolved.source, 'system')
}

{
  const env = makeEnv({ platform: 'win32', present: [] })
  const resolved = resolveManagedPython(env)
  assert.equal(resolved.command, 'python', 'falls back to system python on windows')
  assert.equal(resolved.source, 'system')
}

{
  const blank = makeEnv({ pythonOverride: '   ', present: [] })
  assert.equal(resolveManagedPython(blank).source, 'system', 'blank override is ignored')
}

// --- node / npm ------------------------------------------------------------

{
  const env = makeEnv({ execPath: '/app/Multicode' })
  assert.equal(managedNodeBinary(env), '/app/Multicode', 'managed node is the electron binary')
}

{
  const result = managedNodeEnv({ FOO: 'bar' })
  assert.equal(result.ELECTRON_RUN_AS_NODE, '1', 'sets ELECTRON_RUN_AS_NODE')
  assert.equal(result.FOO, 'bar', 'preserves existing env')
}

{
  const npm = join('/app/resources', 'runtime', 'npm', 'bin', 'npm-cli.js')
  const env = makeEnv({ present: [npm] })
  assert.equal(bundledNpmCliPath(env), npm, 'finds bundled npm cli')
  assert.equal(bundledNpmCliPath(makeEnv({ present: [] })), null, 'null when npm not vendored')
}

// --- PATH shim injection ---------------------------------------------------

{
  const env = withManagedRuntimePath({ PATH: '/usr/bin:/bin' }, '/shim', 'linux')
  assert.equal(env.PATH, `/shim:/usr/bin:/bin`, 'prepends shim dir to PATH')
}

{
  const already = withManagedRuntimePath({ PATH: '/shim:/usr/bin' }, '/shim', 'linux')
  assert.equal(already.PATH, '/shim:/usr/bin', 'idempotent when shim already present')
}

{
  // Windows uses the case-insensitive Path key and `;` delimiter (delimiter is
  // platform-dependent at runtime; assert structure rather than separator).
  const env = withManagedRuntimePath({ Path: 'C:\\Windows' }, 'C:\\shim', 'win32')
  assert.ok(env.Path?.startsWith('C:\\shim'), 'prepends shim dir on windows Path key')
}

// --- bundled python env sanitization ---------------------------------------

{
  const env = { PATH: '/usr/bin', PYTHONHOME: '/opt/pyenv', PYTHONSTARTUP: '/x', PYTHONPATH: '/repo' }
  const sanitized = managedPythonSpawnEnv(env, 'bundled')
  assert.equal(sanitized.PYTHONHOME, undefined, 'bundled strips PYTHONHOME')
  assert.equal(sanitized.PYTHONSTARTUP, undefined, 'bundled strips PYTHONSTARTUP')
  assert.equal(sanitized.PYTHONPATH, '/repo', 'bundled keeps PYTHONPATH')
  assert.equal(sanitized.PATH, '/usr/bin', 'bundled keeps PATH')
  assert.equal(env.PYTHONHOME, '/opt/pyenv', 'does not mutate the source env')
}

for (const source of ['venv', 'system', 'override'] as const) {
  const env = { PYTHONHOME: '/opt/pyenv' }
  const out = managedPythonSpawnEnv(env, source)
  assert.equal(out.PYTHONHOME, '/opt/pyenv', `${source} leaves PYTHONHOME untouched`)
  assert.equal(out, env, `${source} returns the env unchanged (no copy)`)
}

// --- resolution diagnostic --------------------------------------------------

function captureLogger() {
  const logs: string[] = []
  const warns: string[] = []
  return {
    logs,
    warns,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  }
}

// Packaged build that missed the bundled CPython must warn, not log quietly.
for (const source of ['venv', 'system'] as const) {
  const logger = captureLogger()
  const resolved: ResolvedPython = { command: '/usr/bin/python3', source }
  reportManagedPythonResolution(resolved, makeEnv({ isPackaged: true }), logger)
  assert.equal(logger.logs.length, 0, `packaged ${source} does not log at info level`)
  assert.equal(logger.warns.length, 1, `packaged ${source} warns`)
  assert.match(logger.warns[0]!, /expected the bundled CPython/, `packaged ${source} warning explains why`)
}

// Bundled (the happy path) and an explicit override are expected — info only.
for (const source of ['bundled', 'override'] as const) {
  const logger = captureLogger()
  reportManagedPythonResolution({ command: '/x/python', source }, makeEnv({ isPackaged: true }), logger)
  assert.equal(logger.warns.length, 0, `packaged ${source} does not warn`)
  assert.equal(logger.logs.length, 1, `packaged ${source} logs the source`)
  assert.match(logger.logs[0]!, new RegExp(`source=${source}`), `packaged ${source} reports the source`)
}

// Unpackaged (dev) never warns even on a system interpreter — that's normal.
{
  const logger = captureLogger()
  reportManagedPythonResolution({ command: 'python3', source: 'system' }, makeEnv({ isPackaged: false }), logger)
  assert.equal(logger.warns.length, 0, 'dev system python does not warn')
  assert.equal(logger.logs.length, 1, 'dev still logs the resolved source')
}

console.log('managed-runtime.test.ts ok')
