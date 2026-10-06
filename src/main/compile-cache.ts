import { constants, enableCompileCache, flushCompileCache } from 'node:module'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The main process's V8 code cache. Every launch used to compile the app's main
// bundle (a few megabytes of JavaScript across `app-main` and the chunks it
// pulls in) from source before a window could be built. Node can keep the
// compiled code on disk and hand it back to V8 on the next launch, which then
// skips the compile; V8 checks each entry against the source it was made from
// and quietly recompiles anything that no longer matches, so a stale entry
// costs a compile and never runs the wrong code.
//
// One directory per build. The bundle's chunk names carry a content hash, so a
// new build is new file names, and entries keyed by the old names would never
// be read again. Keeping each build's entries in a directory of their own lets
// the previous builds' be deleted whole, once the app is up.

const ROOT_DIRECTORY_NAME = 'main-compile-cache'

/** How long after launch the previous builds' entries are removed: well clear of boot. */
export const COMPILE_CACHE_PRUNE_DELAY_MS = 60_000

/** A directory name for this build, from the stamp minted when it was built. */
export function compileCacheBuildKey(builtAt: string): string {
  return builtAt.replace(/[^0-9A-Za-z]/g, '') || 'unstamped'
}

export type MainCompileCache = {
  /** Writes what has been compiled so far, so a launch that is killed later still leaves a warm cache. */
  flush(): void
  /** Deletes every other build's entries. Best effort. */
  prunePreviousBuilds(): Promise<void>
}

type CompileCacheApi = {
  enable: (directory: string) => { status: number }
  flush: () => void
}

const nodeCompileCache: CompileCacheApi = { enable: enableCompileCache, flush: flushCompileCache }

/**
 * Turns the cache on for every module this process loads from now on. Called
 * by the entry before it imports the app, so the app's own chunks are the ones
 * cached. Null when Node could not use the directory: the app then compiles
 * from source exactly as it did before.
 */
export function enableMainCompileCache(
  userDataDirectory: string,
  buildKey: string,
  api: CompileCacheApi = nodeCompileCache,
): MainCompileCache | null {
  const root = join(userDataDirectory, ROOT_DIRECTORY_NAME)
  let status: number
  try {
    status = api.enable(join(root, buildKey)).status
  } catch {
    return null
  }
  if (status !== constants.compileCacheStatus.ENABLED && status !== constants.compileCacheStatus.ALREADY_ENABLED) {
    return null
  }
  return {
    flush: () => {
      try {
        api.flush()
      } catch {
        // A cache that cannot be written is a slower next launch, nothing more.
      }
    },
    prunePreviousBuilds: async () => {
      const entries = await readdir(root).catch(() => [] as string[])
      await Promise.all(
        entries
          .filter((entry) => entry !== buildKey)
          .map((entry) => rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined)),
      )
    },
  }
}
