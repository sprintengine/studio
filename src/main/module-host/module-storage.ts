import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { workspaceSidecarPath } from '../workspace-sidecar'

// Per-module, per-workspace JSON storage for capability modules (SDK
// getModuleStorage). The host owns file placement so modules stop inventing
// locations: workspace-scoped keys live in the workspace folder
// (`<workspaceRoot>/.sprintengine/modules/<moduleId>/<key>.json`), global keys
// under userData (`<userData>/module-storage/<moduleId>/<key>.json`). The
// registry takes the module id on every call; the SDK helper closes over
// `host.moduleId` (same scoping structure as the Automations module service).
// Disclosure permission: `storage` (install-time, like every v1 scope).

export type ModuleStorageErrorCode =
  | 'invalid_key'
  | 'invalid_value'
  | 'value_too_large'
  | 'invalid_workspace_root'
  | 'io_error'

export type ModuleStorageResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: ModuleStorageErrorCode; message: string }

type ModuleStorageScope = {
  /**
   * Absolute workspace folder for workspace-scoped keys; omit for the
   * module's global (per-user) store.
   */
  workspaceRoot?: string
}

export type ModuleStorageRegistry = {
  get(moduleId: string, input: ModuleStorageScope & { key: string }): Promise<
    ModuleStorageResult<{ value: unknown; found: boolean }>
  >
  set(moduleId: string, input: ModuleStorageScope & { key: string; value: unknown }): Promise<
    ModuleStorageResult<object>
  >
  delete(moduleId: string, input: ModuleStorageScope & { key: string }): Promise<
    ModuleStorageResult<{ deleted: boolean }>
  >
  list(moduleId: string, input?: ModuleStorageScope): Promise<ModuleStorageResult<{ keys: string[] }>>
}

// Keys are file names (minus `.json`), so the charset is locked down; 64 chars
// keeps paths portable. Module ids come from validated manifests, but they are
// path segments here too, so they get the same defensive check.
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
// Windows resolves these to device paths regardless of extension ("con.json"
// is still the console), so they are invalid keys on every platform — a key
// that only works off-Windows is not a portable contract.
const WINDOWS_RESERVED_KEY = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/
// Manifest ids allow uppercase per the manifest validator? They are used as
// folder names all over the module system already; reject only separators and
// traversal rather than re-validating the manifest grammar.
const UNSAFE_SEGMENT = /[\\/]|^\.\.?$/

export const MODULE_STORAGE_VALUE_LIMIT_BYTES = 1024 * 1024

function failure<T>(code: ModuleStorageErrorCode, message: string): ModuleStorageResult<T> {
  return { ok: false, code, message }
}

export function createModuleStorageRegistry(options: { userDataDir: () => string }): ModuleStorageRegistry {
  // One write chain serializes mutations so concurrent set/delete calls can't
  // interleave a temp-write with a rename (same discipline as trust-store).
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(work)
    writeChain = run.catch(() => undefined)
    return run
  }

  const resolveDir = (
    moduleId: string,
    scope: ModuleStorageScope | undefined
  ): { ok: true; dir: string } | { ok: false; code: ModuleStorageErrorCode; message: string } => {
    if (UNSAFE_SEGMENT.test(moduleId) || moduleId.trim().length === 0) {
      return { ok: false, code: 'io_error', message: `Module id "${moduleId}" is not usable as a storage folder.` }
    }
    const workspaceRoot = scope?.workspaceRoot
    if (workspaceRoot !== undefined) {
      if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
        return {
          ok: false,
          code: 'invalid_workspace_root',
          message: 'workspaceRoot must be an absolute path (resolve it via the workspace context).',
        }
      }
      return { ok: true, dir: workspaceSidecarPath(workspaceRoot, 'modules', moduleId) }
    }
    return { ok: true, dir: join(options.userDataDir(), 'module-storage', moduleId) }
  }

  const validateKey = (key: string): string | null => {
    if (!KEY_PATTERN.test(key)) {
      return `Key "${key}" is invalid — keys match ${KEY_PATTERN} (lowercase alphanumerics, dot, dash, underscore; max 64 chars).`
    }
    if (WINDOWS_RESERVED_KEY.test(key)) {
      return `Key "${key}" is a reserved device name on Windows and cannot be used.`
    }
    return null
  }

  return {
    async get(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      const path = join(dir.dir, `${input.key}.json`)
      let source: string
      try {
        source = await readFile(path, 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: undefined, found: false }
        return failure('io_error', error instanceof Error ? error.message : String(error))
      }
      try {
        return { ok: true, value: JSON.parse(source) as unknown, found: true }
      } catch {
        // A corrupt record is an explicit error, never silently "missing" —
        // callers must not overwrite data the user might want to recover.
        return failure('io_error', `Stored value for "${input.key}" is not valid JSON.`)
      }
    },

    async set(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      let serialized: string
      try {
        serialized = JSON.stringify(input.value)
      } catch (error) {
        return failure('invalid_value', error instanceof Error ? error.message : String(error))
      }
      if (serialized === undefined) {
        return failure('invalid_value', 'Value must be JSON-serializable (undefined is not).')
      }
      if (Buffer.byteLength(serialized, 'utf8') > MODULE_STORAGE_VALUE_LIMIT_BYTES) {
        return failure('value_too_large', `Value exceeds the ${MODULE_STORAGE_VALUE_LIMIT_BYTES / 1024 / 1024} MB cap.`)
      }
      return enqueue(async () => {
        const path = join(dir.dir, `${input.key}.json`)
        try {
          await mkdir(dir.dir, { recursive: true })
          const tmp = `${path}.tmp`
          await writeFile(tmp, serialized, 'utf8')
          await rename(tmp, path)
          return { ok: true as const }
        } catch (error) {
          return failure<object>('io_error', error instanceof Error ? error.message : String(error))
        }
      })
    },

    async delete(moduleId, input) {
      const keyIssue = validateKey(input.key)
      if (keyIssue) return failure('invalid_key', keyIssue)
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      return enqueue(async () => {
        const path = join(dir.dir, `${input.key}.json`)
        try {
          await readFile(path, 'utf8')
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true as const, deleted: false }
          return failure<{ deleted: boolean }>('io_error', error instanceof Error ? error.message : String(error))
        }
        try {
          await rm(path)
          return { ok: true as const, deleted: true }
        } catch (error) {
          return failure<{ deleted: boolean }>('io_error', error instanceof Error ? error.message : String(error))
        }
      })
    },

    async list(moduleId, input) {
      const dir = resolveDir(moduleId, input)
      if (!dir.ok) return dir
      let entries: string[]
      try {
        entries = await readdir(dir.dir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, keys: [] }
        return failure('io_error', error instanceof Error ? error.message : String(error))
      }
      const keys = entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .filter((key) => KEY_PATTERN.test(key))
        .sort()
      return { ok: true, keys }
    },
  }
}
