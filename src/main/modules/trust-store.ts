import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'

// Record of the third-party modules the user has trusted, keyed by module id to
// the *manifest fingerprint* that was trusted (see module-signature.ts). Binding
// trust to content means reinstalling a different manifest under the same id
// does not inherit trust. Persisted in userData as a JSON object {id: fp}; a
// missing/malformed file means "nothing trusted" — the safe default.

const FILE_NAME = 'trusted-modules.json'

function trustedModulesPath(userDataDir: string): string {
  return join(userDataDir, FILE_NAME)
}

function parseTrustedModules(raw: string): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const out = new Map<string, string>()
    for (const [id, fingerprint] of Object.entries(parsed as Record<string, unknown>)) {
      if (id.length > 0 && typeof fingerprint === 'string' && fingerprint.length > 0) out.set(id, fingerprint)
    }
    return out
  } catch {
    return new Map()
  }
}

export function readTrustedModulesSync(userDataDir: string): Map<string, string> {
  const path = trustedModulesPath(userDataDir)
  if (!existsSync(path)) return new Map()
  try {
    return parseTrustedModules(readFileSync(path, 'utf8'))
  } catch {
    return new Map()
  }
}

export type TrustWriteResult = { ok: boolean; message?: string }

async function persist(userDataDir: string, trusted: Map<string, string>): Promise<TrustWriteResult> {
  const path = trustedModulesPath(userDataDir)
  try {
    await mkdir(userDataDir, { recursive: true })
    const tmp = `${path}.tmp`
    const record: Record<string, string> = {}
    for (const id of [...trusted.keys()].sort()) record[id] = trusted.get(id)!
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
    await rename(tmp, path)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'write_failed' }
  }
}

// Serialize read-modify-write so two rapid trust toggles can't lose an update
// (each call re-reads the on-disk state after the previous write completes).
let writeChain: Promise<unknown> = Promise.resolve()

// `previous` is what this id mapped to before the write (null when it was not
// trusted). It is what a caller restores when the work the grant belongs to
// fails afterwards — the marketplace install grants trust before writing its
// receipt, and a failed receipt write has to put the entry back as it was.
export async function setModuleTrust(
  userDataDir: string,
  id: string,
  fingerprint: string | null
): Promise<{ result: TrustWriteResult; trustedModules: Map<string, string>; previous: string | null }> {
  const run = writeChain.then(async () => {
    const current = readTrustedModulesSync(userDataDir)
    const previous = current.get(id) ?? null
    if (fingerprint) current.set(id, fingerprint)
    else current.delete(id)
    const result = await persist(userDataDir, current)
    return { result, trustedModules: current, previous }
  })
  // Keep the chain alive even if this link rejects, so a failure doesn't wedge it.
  writeChain = run.catch(() => undefined)
  return run
}
