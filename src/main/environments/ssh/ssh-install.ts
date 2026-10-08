import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { createGunzip, gzip } from 'node:zlib'

import { NODE_RUNTIME_REL, serverTreeName } from '../../hosts/remote-install'
import { appPayloadDigest, buildTar } from '../../hosts/wsl-install'
import {
  ensureWslNodeArchive,
  remoteNodePackage,
  type NodeDownloadDeps,
  type RemoteNodeTarget,
} from '../../hosts/wsl-node-runtime'

const gzipAsync = promisify(gzip)

// What an SSH machine is sent to install (phase 8 spec, 5.3): one archive,
// streamed over the session after `@@SPRINTENGINE_SEND`, holding the pinned
// Node binary when the remote has none, and this app's server tree when it
// has another version or none.
//
// The Node binary comes from the pinned archive, downloaded and checked on the
// desktop (with the app's own network stack, so the system proxy applies) and
// cut down to `bin/node`: npm and the headers are two hundred megabytes the
// server does not run (decision R28 puts the desktop's own npm in the bundle
// instead). The cut binary is kept beside the archive, so it is read once.

/** One entry's bytes out of a gzipped tar, streamed: only that entry is held in memory. */
export async function extractTarEntry(archivePath: string, wanted: string): Promise<Buffer> {
  const stream = createReadStream(archivePath).pipe(createGunzip())
  let pending: Buffer = Buffer.alloc(0)
  let longName: string | null = null
  let entry: { name: string; left: number; pad: number; type: string; parts: Buffer[] } | null = null
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    for (;;) {
      if (entry) {
        if (entry.left > 0) {
          if (pending.length === 0) break
          const take = Math.min(entry.left, pending.length)
          if (entry.type === 'L' || entry.type === 'x' || entry.name === wanted)
            entry.parts.push(pending.subarray(0, take))
          pending = pending.subarray(take)
          entry.left -= take
          if (entry.left > 0) break
        }
        if (pending.length < entry.pad) break
        pending = pending.subarray(entry.pad)
        const body = Buffer.concat(entry.parts)
        const done = entry
        entry = null
        if (done.type === 'L') longName = body.toString('utf8').replace(/\0+$/u, '')
        else if (done.type === 'x') {
          const path = /\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'))
          if (path) longName = path[1]!
        } else if (done.name === wanted && (done.type === '0' || done.type === '\0')) {
          stream.destroy()
          return body
        }
        continue
      }
      if (pending.length < 512) break
      const header = pending.subarray(0, 512)
      pending = pending.subarray(512)
      if (header.every((byte) => byte === 0)) continue
      const field = (start: number, length: number) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .replace(/\0.*$/su, '')
      const size = Number.parseInt(field(124, 12).trim() || '0', 8)
      const type = field(156, 1) || '0'
      const prefix = field(345, 155)
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
      if (type !== 'L' && type !== 'x') longName = null
      entry = { name, left: size, pad: (512 - (size % 512)) % 512, type, parts: [] }
    }
  }
  throw new Error(`The archive has no ${wanted}.`)
}

export type NodeBinary = { binary: Buffer; digest: string; target: RemoteNodeTarget }

/** The pinned Node binary for a remote target: downloaded and checked once, cut once, then read from disk. */
export async function ensureNodeBinary(
  target: RemoteNodeTarget,
  deps: NodeDownloadDeps & { cacheDir: string },
): Promise<NodeBinary> {
  const pkg = remoteNodePackage(target)
  const cut = join(deps.cacheDir, `${pkg.dirName}.node`)
  const marker = `${cut}.sha256`
  try {
    if ((await readFile(marker, 'utf8')).trim() === pkg.sha256)
      return { binary: await readFile(cut), digest: pkg.sha256, target }
  } catch {
    // Not cut yet.
  }
  const archive = await ensureWslNodeArchive(pkg, deps)
  const binary = await extractTarEntry(archive, `${pkg.dirName}/bin/node`)
  await mkdir(deps.cacheDir, { recursive: true })
  await writeFile(`${cut}.part`, binary, { mode: 0o600 })
  await rename(`${cut}.part`, cut)
  await writeFile(marker, `${pkg.sha256}\n`)
  return { binary, digest: pkg.sha256, target }
}

/** The server tree's digest, computed as WSL computes it, so both kinds of host mark one tree alike. */
export function serverTreeDigest(dir: string): string {
  return appPayloadDigest([{ dir, into: '' }])
}

export type InstallArchive = { tarGz: Buffer; bytes: number; unpackedBytes: number }

/**
 * The one archive a session streams: `runtime/node-<v>/bin/node` (0700) when
 * `node` is given, and `server-<version>/…` when `server` is.
 */
export async function buildInstallArchive(input: {
  node: Buffer | null
  server: { dir: string; version: string } | null
}): Promise<InstallArchive> {
  const files: Array<{ path: string; data: Buffer; mode?: number }> = []
  if (input.node) files.push({ path: `${NODE_RUNTIME_REL}/bin/node`, data: input.node, mode: 0o700 })
  if (input.server) {
    // The same walk and order as the WSL payload, under the tree's own name.
    const payloadFiles = collectTree(input.server.dir)
    const tree = serverTreeName(input.server.version)
    for (const file of payloadFiles) files.push({ path: `${tree}/${file.path}`, data: file.data })
  }
  const tar = buildTar(files)
  const unpackedBytes = files.reduce((sum, file) => sum + file.data.length, 0)
  // Compressed on zlib's threads: a server tree and a Node binary take long enough to hold the app.
  const tarGz = await gzipAsync(tar, { level: 6 })
  return { tarGz, bytes: tarGz.length, unpackedBytes }
}

/** Every file of the tree, by its path inside it, sorted as `buildAppPayload` sorts them. */
function collectTree(dir: string): Array<{ path: string; data: Buffer }> {
  const out: Array<{ path: string; data: Buffer }> = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push({ path: relative(dir, path).split(sep).join('/'), data: readFileSync(path) })
    }
  }
  walk(dir)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
