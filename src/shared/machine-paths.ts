// How this computer spells a path on another machine (an SSH machine, phase
// 8): `ssh://<saved id>/home/dev/repo`. A workspace on such a machine keeps
// its folder in this spelling, so nothing on this computer can mistake it for
// one of its own paths: a local file API handed one finds nothing, and the
// desktop's file and git channels send it to that machine's server instead
// (shared/machine-channels.ts). The machine's server is handed the plain
// path, `/home/dev/repo`.

const PREFIX = 'ssh://'
const ID = /^[A-Za-z0-9_-]{1,64}$/u

/** A path on an SSH machine as this computer spells it. */
export function machinePath(id: string, path: string): string {
  if (!ID.test(id)) throw new Error(`Not a machine id: ${JSON.stringify(id)}`)
  if (!path.startsWith('/')) throw new Error(`A path on a machine is absolute: ${JSON.stringify(path)}`)
  return `${PREFIX}${id}${path}`
}

export function isMachinePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** The machine and the plain path a spelled path names, or null for any other string. */
export function parseMachinePath(value: string): { id: string; path: string } | null {
  if (!value.startsWith(PREFIX)) return null
  const rest = value.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  const id = slash === -1 ? rest : rest.slice(0, slash)
  if (!ID.test(id)) return null
  return { id, path: slash === -1 ? '/' : rest.slice(slash) }
}
