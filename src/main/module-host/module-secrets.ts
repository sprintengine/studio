// Brokered secrets for modules (SDK `getSecretsService`, permission `secrets`).
//
// A module stores an API key once and names the origins it may be sent to;
// after that it can only ask the host to make a request WITH the key. The value
// is never handed back: not by `has`, not in a response (an echoing server's
// copy is redacted), not in an error message. That is the whole point of the
// broker — module code, and whatever it renders, never holds the credential.
//
// Storage: one file per module under `<userData>/module-secrets/`, the whole
// record (every name's value AND its allowed origins) sealed with the platform's
// secret cipher (Electron's `safeStorage` in the desktop), so the allow-list cannot be widened by editing the file. On a
// system that cannot encrypt, nothing is stored and `set` says
// `storage_unavailable` — a plaintext key on disk is the thing this avoids, and
// a key that silently vanished at quit would surprise the module more than a
// refusal does. Nothing is cached in memory: each call reads the file, so
// removing a module's file (deleteModuleSecrets, on uninstall) takes effect at
// once.
//
// The allow-list is bound at `set`: https origins only, exact origin match (no
// wildcards, no subdomains), and changing it means setting the value again.
// Requests go out with `redirect: 'error'`, a deadline, and a 1 MiB cap on the
// answer (broker-http.ts).
//
// Permissions are read per call from the module's declared list, as the
// conversation service does. The calls that answer a result say
// `permission_missing`; `has` cannot, so it rejects — calling it without the
// permission is a mistake in the module, not a state of the world. A request
// shape the module got wrong (a bad method, header name or value) rejects with
// a TypeError for the same reason.

import { mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

import type {
  ModuleSecretFetchInit,
  ModuleSecretFetchResult,
  ModuleSecretsError,
  ModuleSecretsRegistry,
  ModuleSecretsService,
} from '../../shared/modules/brokers'
import { openSecret, sealSecret, type SecretCipher } from '../../server/platform/secret-cipher'
import { brokerRequest, brokerTimeout, redactSecret, type BrokerFetch } from './broker-http'

export type ModuleSecretsDeps = {
  /** The app's data directory; secrets live under `module-secrets/` in it. */
  userDataDir: string
  /** The platform's secret cipher; null where there is none (nothing can be stored). */
  cipher: SecretCipher | null
  /** The permissions the module declared in its manifest. */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /** Defaults to the global fetch. */
  fetch?: BrokerFetch
}

export type ModuleSecretsModuleRegistry = {
  forModule(moduleId: string): ModuleSecretsService
  /** The moduleId-first shape the `module-secrets.module-service` token carries. */
  registry: ModuleSecretsRegistry
}

type Failure = { ok: false; code: ModuleSecretsError; message: string }

type StoredSecret = { value: string; allowedOrigins: string[] }
type StoredRecord = { version: 1; secrets: Record<string, StoredSecret> }

export const MODULE_SECRET_RESPONSE_LIMIT_BYTES = 1024 * 1024
const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SECRET_VALUE_LIMIT = 16 * 1024
const MAX_ALLOWED_ORIGINS = 16
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
// RFC 9110 token characters: what a header name may be made of.
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
// Control characters other than tab end a header value early or smuggle a new
// header in; a value holding one is refused rather than repaired.
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f]/
// Module ids come from validated manifests, but they are file names here too.
const UNSAFE_SEGMENT = /[\\/]|^\.\.?$/

function failure(code: ModuleSecretsError, message: string): Failure {
  return { ok: false, code, message }
}

function secretsDir(userDataDir: string): string {
  return join(userDataDir, 'module-secrets')
}

function secretsPath(userDataDir: string, moduleId: string): string {
  if (!moduleId || UNSAFE_SEGMENT.test(moduleId)) throw new TypeError(`Module id "${moduleId}" is not a valid id.`)
  return join(secretsDir(userDataDir), `${encodeURIComponent(moduleId)}.bin`)
}

/**
 * Forget every secret a module stored. For uninstall: a later module that
 * takes the same id must not inherit keys the person gave the one before it.
 */
export async function deleteModuleSecrets(userDataDir: string, moduleId: string): Promise<void> {
  await rm(secretsPath(userDataDir, moduleId), { force: true })
}

/** An https origin as the allow-list holds it (`https://host[:port]`), or null. */
export function normalizeAllowedOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  return url.origin
}

export function createModuleSecretsRegistry(deps: ModuleSecretsDeps): ModuleSecretsModuleRegistry {
  const fetchImpl: BrokerFetch = deps.fetch ?? ((input, init) => fetch(input, init))
  // Writes to one module's file run one at a time, so two `set`s racing each
  // other both land instead of the second overwriting the first's read.
  const writeChains = new Map<string, Promise<unknown>>()

  function hasPermission(moduleId: string): boolean {
    return (deps.getModulePermissions(moduleId) ?? []).includes('secrets')
  }
  function missing(moduleId: string): Failure {
    return failure('permission_missing', `Module "${moduleId}" must declare the "secrets" permission.`)
  }
  function encryptionAvailable(): boolean {
    try {
      return deps.cipher?.available() === true
    } catch {
      return false
    }
  }
  function unavailable(): Failure {
    return failure('storage_unavailable', 'This system cannot encrypt secrets, so none can be stored.')
  }
  function invalidName(name: unknown): Failure | null {
    if (typeof name === 'string' && SECRET_NAME_PATTERN.test(name)) return null
    return failure(
      'invalid_name',
      'A secret name is 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.',
    )
  }

  async function readRecord(moduleId: string): Promise<StoredRecord> {
    const empty: StoredRecord = { version: 1, secrets: {} }
    let sealed: Buffer
    try {
      sealed = await readFile(secretsPath(deps.userDataDir, moduleId))
    } catch {
      return empty
    }
    if (!deps.cipher || !encryptionAvailable()) return empty
    try {
      const parsed = JSON.parse(await openSecret(deps.cipher, sealed)) as Partial<StoredRecord>
      if (parsed?.version !== 1 || typeof parsed.secrets !== 'object' || parsed.secrets === null) return empty
      const secrets: Record<string, StoredSecret> = {}
      for (const [name, entry] of Object.entries(parsed.secrets)) {
        if (typeof entry?.value !== 'string' || !Array.isArray(entry.allowedOrigins)) continue
        secrets[name] = {
          value: entry.value,
          allowedOrigins: entry.allowedOrigins.filter((origin): origin is string => typeof origin === 'string'),
        }
      }
      return { version: 1, secrets }
    } catch {
      // Sealed under another key (a copied profile) or damaged: nothing usable.
      return empty
    }
  }

  async function writeRecord(moduleId: string, record: StoredRecord): Promise<void> {
    const path = secretsPath(deps.userDataDir, moduleId)
    if (Object.keys(record.secrets).length === 0) {
      await unlink(path).catch(() => {})
      return
    }
    if (!deps.cipher) throw new Error('No cipher.')
    await mkdir(secretsDir(deps.userDataDir), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, await sealSecret(deps.cipher, JSON.stringify(record)), { mode: 0o600 })
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  function serialized<T>(moduleId: string, work: () => Promise<T>): Promise<T> {
    const previous = writeChains.get(moduleId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => {})
    writeChains.set(moduleId, settled)
    void settled.then(() => {
      if (writeChains.get(moduleId) === settled) writeChains.delete(moduleId)
    })
    return next
  }

  function forModule(moduleId: string): ModuleSecretsService {
    return {
      async set(name, value, options) {
        if (!hasPermission(moduleId)) return missing(moduleId)
        const badName = invalidName(name)
        if (badName) return badName
        if (typeof value !== 'string') throw new TypeError(`Secret "${name}" needs a string value.`)
        const trimmed = value.trim()
        if (!trimmed || trimmed.length > SECRET_VALUE_LIMIT || HEADER_VALUE_UNSAFE.test(trimmed)) {
          throw new TypeError(
            `Secret "${name}" needs a non-empty value of at most ${SECRET_VALUE_LIMIT} characters without line breaks or control characters.`,
          )
        }
        const requested: unknown = options?.allowedOrigins
        if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_ALLOWED_ORIGINS) {
          return failure(
            'origin_not_allowed',
            `Secret "${name}" needs 1-${MAX_ALLOWED_ORIGINS} allowed origins, each an https origin such as "https://api.example.com".`,
          )
        }
        const allowedOrigins: string[] = []
        for (const candidate of requested) {
          const origin = normalizeAllowedOrigin(candidate)
          if (!origin) {
            return failure(
              'origin_not_allowed',
              `${JSON.stringify(String(candidate)).slice(0, 200)} is not an https origin; name each origin as "https://host[:port]" with no path.`,
            )
          }
          if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin)
        }
        if (!encryptionAvailable()) return unavailable()
        try {
          await serialized(moduleId, async () => {
            const record = await readRecord(moduleId)
            record.secrets[name] = { value: trimmed, allowedOrigins }
            await writeRecord(moduleId, record)
          })
        } catch {
          return failure('storage_unavailable', `Secret "${name}" could not be stored.`)
        }
        return { ok: true }
      },

      async has(name) {
        if (!hasPermission(moduleId)) throw new Error(missing(moduleId).message)
        if (invalidName(name)) return false
        return Object.hasOwn((await readRecord(moduleId)).secrets, name)
      },

      async delete(name) {
        if (!hasPermission(moduleId)) return missing(moduleId)
        const badName = invalidName(name)
        if (badName) return badName
        try {
          await serialized(moduleId, async () => {
            const record = await readRecord(moduleId)
            if (!Object.hasOwn(record.secrets, name)) return
            delete record.secrets[name]
            await writeRecord(moduleId, record)
          })
        } catch {
          return failure('storage_unavailable', `Secret "${name}" could not be removed.`)
        }
        return { ok: true }
      },

      async fetchWithSecret(name, url, init) {
        if (!hasPermission(moduleId)) return missing(moduleId)
        const badName = invalidName(name)
        if (badName) return badName
        const request = normalizeInit(init)

        let target: URL
        try {
          target = new URL(url)
        } catch {
          return failure('origin_not_allowed', 'The request URL is not an absolute URL.')
        }
        if (target.protocol !== 'https:') {
          return failure('origin_not_allowed', 'A secret is only ever sent over https.')
        }
        if (target.username || target.password) {
          return failure('origin_not_allowed', 'The request URL may not carry credentials of its own.')
        }

        if (!encryptionAvailable()) return unavailable()
        const record = await readRecord(moduleId)
        // Own names only: `constructor` or `toString` would otherwise read
        // the object's inherited function as a stored secret.
        const stored = Object.hasOwn(record.secrets, name) ? record.secrets[name] : undefined
        if (!stored) return failure('not_set', `Secret "${name}" is not set.`)
        if (!stored.allowedOrigins.includes(target.origin)) {
          return failure(
            'origin_not_allowed',
            `Secret "${name}" may not be sent to ${target.origin}; it was stored for ${stored.allowedOrigins.join(', ')}.`,
          )
        }

        const secret = stored.value
        const headers = { ...request.headers }
        if ('header' in request.placement) {
          const placementHeader = request.placement.header.toLowerCase()
          // The secret's header is the host's: a module header of the same
          // name (any case) would be sent beside it or instead of it.
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === placementHeader) delete headers[key]
          }
          const scheme = request.placement.scheme ?? ''
          headers[request.placement.header] = scheme ? `${scheme} ${secret}` : secret
        } else {
          target.searchParams.set(request.placement.query, secret)
        }

        const outcome = await brokerRequest(
          fetchImpl,
          target.toString(),
          { method: request.method, headers, ...(request.body !== undefined ? { body: request.body } : {}) },
          {
            timeoutMs: request.timeoutMs,
            maxBytes: MODULE_SECRET_RESPONSE_LIMIT_BYTES,
            label: target.origin,
          },
        )
        if (!outcome.ok) return failure('network_error', outcome.message)

        // Every spelling the secret went out in: as itself, percent-encoded,
        // and form-encoded as `searchParams` writes a query placement (a
        // space as `+`, `~!'()` escaped), which a server echoing the request
        // URL in an error body would hand straight back.
        const spellings = [secret, encodeURIComponent(secret), new URLSearchParams([['', secret]]).toString().slice(1)]
        const scrub = (text: string): string => spellings.reduce(redactSecret, text)
        const responseHeaders: Record<string, string> = {}
        for (const [key, value] of Object.entries(outcome.response.headers)) {
          // A cookie the service sets is a session credential of its own; the
          // host holds the key so the module does not hold its sessions either.
          if (key === 'set-cookie') continue
          responseHeaders[key] = scrub(value)
        }
        const result: ModuleSecretFetchResult = {
          ok: true,
          status: outcome.response.status,
          headers: responseHeaders,
          body: scrub(outcome.response.body),
        }
        return result
      },
    }
  }

  const services = new Map<string, ModuleSecretsService>()
  const serviceFor = (moduleId: string): ModuleSecretsService => {
    let service = services.get(moduleId)
    if (!service) {
      service = forModule(moduleId)
      services.set(moduleId, service)
    }
    return service
  }

  const registry: ModuleSecretsRegistry = {
    set: (moduleId, name, value, options) => serviceFor(moduleId).set(name, value, options),
    has: (moduleId, name) => serviceFor(moduleId).has(name),
    delete: (moduleId, name) => serviceFor(moduleId).delete(name),
    fetchWithSecret: (moduleId, name, url, init) => serviceFor(moduleId).fetchWithSecret(name, url, init),
  }

  return { forModule: serviceFor, registry }
}

type NormalizedInit = {
  method: string
  headers: Record<string, string>
  body?: string
  placement: { header: string; scheme?: 'Bearer' | 'token' | 'Basic' | '' } | { query: string }
  timeoutMs: number
}

function normalizeInit(init: ModuleSecretFetchInit): NormalizedInit {
  if (typeof init !== 'object' || init === null) throw new TypeError('fetchWithSecret needs an init with a placement.')
  const method = (init.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) throw new TypeError(`Method "${init.method}" is not one fetchWithSecret sends.`)

  const headers: Record<string, string> = {}
  if (init.headers !== undefined) {
    if (typeof init.headers !== 'object' || init.headers === null) throw new TypeError('headers must be an object.')
    for (const [name, value] of Object.entries(init.headers)) {
      if (!HEADER_NAME_PATTERN.test(name)) throw new TypeError(`"${name}" is not a valid header name.`)
      if (typeof value !== 'string' || HEADER_VALUE_UNSAFE.test(value)) {
        throw new TypeError(`Header "${name}" needs a string value without line breaks.`)
      }
      headers[name] = value
    }
  }

  if (init.body !== undefined && typeof init.body !== 'string') throw new TypeError('body must be a string.')
  if (init.body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`A ${method} request carries no body.`)
  }

  const placement = init.placement as NormalizedInit['placement'] | undefined
  if (typeof placement !== 'object' || placement === null) {
    throw new TypeError('fetchWithSecret needs a placement: { header } or { query }.')
  }
  let normalizedPlacement: NormalizedInit['placement']
  if ('header' in placement) {
    if (typeof placement.header !== 'string' || !HEADER_NAME_PATTERN.test(placement.header)) {
      throw new TypeError('placement.header must be a valid header name.')
    }
    const scheme = placement.scheme ?? ''
    if (scheme !== '' && scheme !== 'Bearer' && scheme !== 'token' && scheme !== 'Basic') {
      throw new TypeError('placement.scheme must be "Bearer", "token", "Basic" or "".')
    }
    normalizedPlacement = { header: placement.header, scheme }
  } else if ('query' in placement) {
    if (typeof placement.query !== 'string' || placement.query.trim() === '') {
      throw new TypeError('placement.query must name a query parameter.')
    }
    normalizedPlacement = { query: placement.query }
  } else {
    throw new TypeError('fetchWithSecret needs a placement: { header } or { query }.')
  }

  return {
    method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    placement: normalizedPlacement,
    timeoutMs: brokerTimeout(init.timeoutMs),
  }
}
