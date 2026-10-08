/**
 * A random id: `bytes` random bytes from `getRandomValues`, in hex. Used where
 * an id only has to be unique and unguessable (a command id a resend is matched
 * on, a connection's client id), never where it is parsed.
 *
 * `getRandomValues` rather than `randomUUID` because the web client may run
 * outside a secure context, where `randomUUID` does not exist; it is on
 * `globalThis.crypto` in Node, Electron's main process and every browser alike.
 */
export function randomId(bytes = 12): string {
  const values = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(values)
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** {@link randomId} after a prefix saying what minted it: `ssh-…`, `web-…`. */
export function prefixedId(prefix: string, bytes = 12): string {
  return `${prefix}-${randomId(bytes)}`
}
