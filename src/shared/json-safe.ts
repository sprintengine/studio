// What crosses a web tab's IPC tunnel is JSON, where a desktop window's port
// carries structured clones. A value JSON would change on the way (a `Date`
// becomes a string, a `Map` an empty object, bytes an object of indices, `NaN`
// a null) is refused out loud instead of arriving mangled: the sender learns
// which member it was, rather than the receiver reading a wrong value.

export class NotJsonSafe extends Error {
  readonly path: string
  constructor(path: string, what: string) {
    super(`${path} is ${what}, which does not cross a web tab's connection unchanged.`)
    this.name = 'NotJsonSafe'
    this.path = path
  }
}

function describe(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null
    case 'number':
      return Number.isFinite(value) ? null : String(value)
    case 'bigint':
      return 'a bigint'
    case 'function':
      return 'a function'
    case 'symbol':
      return 'a symbol'
    default:
      return null
  }
}

/** Throw `NotJsonSafe` naming the first member JSON would not carry as it is. */
export function assertJsonSafe(value: unknown, path = 'value', depth = 0): void {
  if (value === null || value === undefined) return
  const scalar = describe(value)
  if (scalar) throw new NotJsonSafe(path, scalar)
  if (typeof value !== 'object') return
  if (depth > 128) throw new NotJsonSafe(path, 'nested too deep')
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (entry === undefined) throw new NotJsonSafe(`${path}[${index}]`, 'undefined in a list')
      assertJsonSafe(entry, `${path}[${index}]`, depth + 1)
    })
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'an object'
    throw new NotJsonSafe(path, `a ${name}`)
  }
  for (const [key, entry] of Object.entries(value)) assertJsonSafe(entry, `${path}.${key}`, depth + 1)
}
