import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Main's copy of every module's app-level state — the `module:<id>`
// namespaces in the renderer's app settings, which a module's Settings
// section writes through `setValue` and `RendererHost.setModuleAppState`
// writes directly. `MainHost.getModuleAppState` / `watchModuleAppState` read
// it, so a module's `entry.main` sees the values the person chose with no
// window open (a scheduler's run time, a poller's interval).
//
// Same one-way contract as the other settings mirrors (text generation,
// background mode): the renderer owns the values and pushes the whole bag on
// change and when a window mounts; main persists the last push in user data
// and reads it synchronously. Nothing in main writes a value back.
//
// One mirror per file, shared by everyone in the process: the IPC handler that
// takes the push and the module host that reads it see the same object, so a
// change is heard in process at once. A Studio server out of process reads
// the same file and hears a push the shell wrote by watching it.

export const MODULE_APP_STATE_FILE = 'module-app-state.json'
const NAMESPACE_PREFIX = 'module:'
const WATCH_INTERVAL_MS = 1000

type Namespaces = Record<string, Record<string, unknown>>

export type ModuleAppStateMirror = {
  /** The module's namespace: an empty object when nothing was ever pushed. */
  get(moduleId: string): Readonly<Record<string, unknown>>
  /** Adopt a renderer push of the whole bag; notifies the namespaces that changed. */
  set(bag: unknown): void
  /** Hear the module's namespace whenever it changes (not on subscribe). */
  subscribe(moduleId: string, listener: (values: Readonly<Record<string, unknown>>) => void): () => void
}

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({})

/** Only `module:<id>` namespaces holding a plain object; everything else is dropped. */
export function normalizeModuleAppStateBag(value: unknown): Namespaces {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Namespaces = {}
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = namespace.trim()
    if (!key.startsWith(NAMESPACE_PREFIX) || key.length === NAMESPACE_PREFIX.length) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    result[key] = { ...(entry as Record<string, unknown>) }
  }
  return result
}

export function createModuleAppStateMirror(options: {
  filePath: string
  /** Watch the file for a push another process wrote. Defaults to true. */
  watchFile?: boolean
  watchIntervalMs?: number
}): ModuleAppStateMirror & { dispose(): void } {
  let namespaces: Namespaces | null = null
  const listeners = new Map<string, Set<(values: Readonly<Record<string, unknown>>) => void>>()
  let watching: ReturnType<typeof setInterval> | null = null
  // What the file looked like when last read or written, so a read with no
  // watch running still notices a push another process wrote since.
  let seen: string | null = null
  const fileSignature = (): string => {
    try {
      const info = statSync(options.filePath)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'absent'
    }
  }

  const read = (): Namespaces => {
    seen = fileSignature()
    try {
      return normalizeModuleAppStateBag(JSON.parse(readFileSync(options.filePath, 'utf8')))
    } catch {
      return {}
    }
  }
  const current = (): Namespaces => (namespaces ??= read())

  // Hand every namespace whose content moved to its listeners.
  const adopt = (next: Namespaces): boolean => {
    const before = current()
    namespaces = next
    let changed = false
    for (const namespace of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (JSON.stringify(before[namespace] ?? {}) === JSON.stringify(next[namespace] ?? {})) continue
      changed = true
      const values = Object.freeze({ ...next[namespace] })
      for (const listener of listeners.get(namespace) ?? []) {
        try {
          listener(values)
        } catch (error) {
          console.warn(`[modules] an app-state watcher for "${namespace}" threw:`, error)
        }
      }
    }
    return changed
  }

  // Poll the file's signature against the one last read or written rather
  // than using fs.watchFile: watchFile takes its baseline from its first
  // asynchronous stat, so a push another process writes before that stat lands
  // becomes the baseline and is never reported. Comparing against `seen` has
  // no baseline to race.
  const startWatching = (): void => {
    if (watching || options.watchFile === false) return
    watching = setInterval(() => {
      if (fileSignature() !== seen) adopt(read())
    }, options.watchIntervalMs ?? WATCH_INTERVAL_MS)
    watching.unref?.()
  }
  const stopWatching = (): void => {
    if (!watching) return
    clearInterval(watching)
    watching = null
  }

  return {
    get(moduleId) {
      if (namespaces !== null && !watching && options.watchFile !== false && fileSignature() !== seen) adopt(read())
      const namespace = current()[`${NAMESPACE_PREFIX}${moduleId.trim()}`]
      return namespace ? Object.freeze({ ...namespace }) : EMPTY
    },
    set(bag) {
      const next = normalizeModuleAppStateBag(bag)
      // An unchanged push (every window mount sends one) never rewrites the file.
      if (!adopt(next)) return
      const tmp = `${options.filePath}.${process.pid}.tmp`
      try {
        mkdirSync(dirname(options.filePath), { recursive: true })
        writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, options.filePath)
        seen = fileSignature()
      } catch {
        // The in-memory copy is current; the file catches up on the next change.
        rmSync(tmp, { force: true })
      }
    },
    subscribe(moduleId, listener) {
      const namespace = `${NAMESPACE_PREFIX}${moduleId.trim()}`
      const set = listeners.get(namespace) ?? new Set()
      set.add(listener)
      listeners.set(namespace, set)
      current()
      startWatching()
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(namespace)
        if (listeners.size === 0) stopWatching()
      }
    },
    dispose() {
      listeners.clear()
      stopWatching()
    },
  }
}

const mirrors = new Map<string, ModuleAppStateMirror>()

/** The process's one mirror over `<userData>/module-app-state.json`. */
export function moduleAppStateMirrorFor(userDataDir: string): ModuleAppStateMirror {
  const filePath = join(userDataDir, MODULE_APP_STATE_FILE)
  let mirror = mirrors.get(filePath)
  if (!mirror) {
    mirror = createModuleAppStateMirror({ filePath })
    mirrors.set(filePath, mirror)
  }
  return mirror
}
