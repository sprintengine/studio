// A directory tree main writes into the distribution through the helper: the
// app's Claude plugin copy, with Linux paths already substituted into it.
//
// The copy is written to a sibling directory and renamed into place, with a
// marker holding its digest written last, so a CLI starting while it is being
// replaced reads either the old copy or the new one and never half of each.
// Every path is checked to stay inside the tree: main is trusted, but a path
// with `..` in it is a bug that should fail loudly rather than write outside.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TREE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/u
const MARKER = '.ready'
export const MAX_TREE_BYTES = 32 * 1024 * 1024

export function checkTreePath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function readMarker(root) {
  try {
    return readFileSync(join(root, MARKER), 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Makes `<appDir>/<name>` hold exactly `files` under `digest`. Without
 * `files`, only reports whether the tree already matches the digest.
 */
export function ensureTree({ appDir, name, digest, files }) {
  if (!TREE_NAME.test(name ?? '')) throw new Error('The tree name is not a plain token.')
  if (typeof digest !== 'string' || !/^[a-f0-9]{16,128}$/u.test(digest)) throw new Error('The digest is not hex.')
  const root = join(appDir, name)
  if (readMarker(root) === digest) return { root, current: true }
  if (!files) return { root, current: false }
  if (!Array.isArray(files)) throw new Error('files must be an array.')
  let total = 0
  for (const file of files) {
    if (!checkTreePath(file?.path)) throw new Error(`Refusing the tree path ${JSON.stringify(file?.path)}.`)
    if (typeof file.b64 !== 'string') throw new Error(`${file.path} has no content.`)
    total += file.b64.length
  }
  if (total > MAX_TREE_BYTES) throw new Error('The tree is larger than the helper accepts.')
  const staging = join(appDir, `.${name}.${process.pid}.tmp`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    for (const file of files) {
      const target = join(staging, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(file.b64, 'base64'), { mode: file.executable ? 0o700 : 0o600 })
    }
    writeFileSync(join(staging, MARKER), digest, { mode: 0o600 })
    if (existsSync(root)) {
      const old = join(appDir, `.${name}.${process.pid}.old`)
      rmSync(old, { recursive: true, force: true })
      renameSync(root, old)
      renameSync(staging, root)
      rmSync(old, { recursive: true, force: true })
    } else {
      renameSync(staging, root)
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return { root, current: true }
}
