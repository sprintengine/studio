// Finding agent CLIs on the person's PATH, without a shell per check.
//
// The login-shell PATH is read once per helper start (`login-env.mjs`). A CLI
// is found by walking that PATH the way `command -v` does, and its version is
// asked only when the file it resolves to is new or has changed (path, size
// and mtime), so a window refocus costs a few `stat` calls rather than a
// process per CLI. The PATH directories on the Linux file system are watched
// (inotify through `fs.watch`); an install or removal there drops the cache
// and tells main, which re-reads availability for this machine.
//
// Directories under `/mnt/` (the Windows PATH WSL appends by default) are still
// searched, last, but never watched: the Windows drives are slow to watch and
// to read, and a program there is rarely the Linux install of a CLI.

import { accessSync, constants, statSync, watch } from 'node:fs'
import { join } from 'node:path'

import { runArgv } from './run.mjs'

export const VERSION_TIMEOUT_MS = 8_000
const MAX_WATCHED_DIRS = 64

function isExecutableFile(path) {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    accessSync(path, constants.X_OK)
    return stats
  } catch {
    return null
  }
}

function pathDirs(pathValue) {
  const dirs = (pathValue ?? '').split(':').filter((dir) => dir.startsWith('/'))
  const unique = [...new Set(dirs)]
  return [...unique.filter((dir) => !dir.startsWith('/mnt/')), ...unique.filter((dir) => dir.startsWith('/mnt/'))]
}

/** `binary` resolved against PATH (or as given, when it names a path). */
export function resolveBinary(binary, env) {
  if (!binary || binary.includes('\0')) return null
  const expanded = binary.startsWith('~/') && env.HOME ? join(env.HOME, binary.slice(2)) : binary
  if (expanded.includes('/')) {
    if (!expanded.startsWith('/')) return null
    const stats = isExecutableFile(expanded)
    return stats ? { path: expanded, stats } : null
  }
  for (const dir of pathDirs(env.PATH)) {
    const candidate = join(dir, expanded)
    const stats = isExecutableFile(candidate)
    if (stats) return { path: candidate, stats }
  }
  return null
}

export function createCliDetector({ getEnv, onPathsChanged, run = runArgv }) {
  const cache = new Map()
  const watchers = []
  let watchedPath = null
  let debounce = null

  function invalidate() {
    cache.clear()
    onPathsChanged?.()
  }

  function watchPath(env) {
    if (watchedPath === env.PATH) return
    for (const watcher of watchers.splice(0)) watcher.close()
    watchedPath = env.PATH
    for (const dir of pathDirs(env.PATH)
      .filter((entry) => !entry.startsWith('/mnt/'))
      .slice(0, MAX_WATCHED_DIRS)) {
      try {
        const watcher = watch(dir, { persistent: false }, () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(invalidate, 1_000)
          debounce.unref?.()
        })
        watcher.on('error', () => watcher.close())
        watchers.push(watcher)
      } catch {
        // A PATH entry that does not exist, or one we may not read.
      }
    }
  }

  async function detectOne(request, env, force) {
    const resolved = resolveBinary(request.binary, env)
    if (!resolved) return { found: false }
    const versionArgs = Array.isArray(request.versionArgs) ? request.versionArgs.map(String) : ['--version']
    const key = JSON.stringify([resolved.path, versionArgs])
    const stamp = `${resolved.stats.size}:${resolved.stats.mtimeMs}`
    const cached = cache.get(key)
    if (!force && cached && cached.stamp === stamp) return cached.answer
    const outcome = await run({
      argv: [resolved.path, ...versionArgs],
      env,
      timeoutMs: VERSION_TIMEOUT_MS,
    })
    const answer = {
      found: true,
      path: resolved.path,
      // `2>&1`, as the shell probe it replaces printed it.
      output: `${outcome.stdout}\n${outcome.stderr}`.trim(),
      timedOut: outcome.timedOut,
    }
    // A timed-out answer is not kept: the next check asks again.
    if (!outcome.timedOut) cache.set(key, { stamp, answer })
    return answer
  }

  return {
    async detect(requests, { force = false } = {}) {
      const env = await getEnv()
      watchPath(env)
      if (force) cache.clear()
      return Promise.all(
        requests.map((request) =>
          detectOne(request, env, force).catch((error) => ({ error: String(error?.message ?? error) })),
        ),
      )
    },
    close() {
      if (debounce) clearTimeout(debounce)
      for (const watcher of watchers.splice(0)) watcher.close()
    },
  }
}
