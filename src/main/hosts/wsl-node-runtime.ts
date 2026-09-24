// The Linux Node the WSL helper runs on, downloaded on this PC on first use.
//
// The helper, the hook reporters and the MCP bridge are plain Node scripts, and
// a distribution may have no Node at all (the native Claude Code installer
// needs none) or one that is too old, broken by an update, or only on PATH in
// an interactive shell. So the app never uses the person's own Node there: it
// brings one pinned build, checked against a pinned SHA-256, and nothing else.
//
// The archive is fetched here on Windows, verified here, and streamed into the
// distribution over `wsl.exe`'s stdin (`wsl-install.ts`). The distribution needs
// no network and no `curl`, and nothing is read through `/mnt/c`, which a
// distribution with automount turned off does not have.
//
// Bumping the version: take the four sums for the new version from
// https://nodejs.org/dist/<version>/SHASUMS256.txt. The helper needs nothing
// newer than Node 18; an LTS line is pinned for its glibc floor (2.28) and its
// support window.

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { WslSetupError } from './wsl-setup-error'

export const WSL_NODE_VERSION = 'v24.21.0'

type Compression = 'xz' | 'gz'
export type WslNodeArch = 'x64' | 'arm64'

const SHA256: Record<WslNodeArch, Record<Compression, string>> = {
  x64: {
    xz: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    gz: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  },
  arm64: {
    xz: '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
    gz: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  },
}

export type WslNodePackage = {
  arch: WslNodeArch
  compression: Compression
  /** `node-v24.21.0-linux-x64`, the archive's top directory. */
  dirName: string
  fileName: string
  url: string
  sha256: string
}

/** `uname -m` as the Node build that runs there, or null for one there is none of. */
export function wslNodeArch(uname: string): WslNodeArch | null {
  const machine = uname.trim()
  if (machine === 'x86_64' || machine === 'amd64') return 'x64'
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64'
  return null
}

export function wslNodePackage(arch: WslNodeArch, compression: Compression): WslNodePackage {
  const dirName = `node-${WSL_NODE_VERSION}-linux-${arch}`
  const fileName = `${dirName}.tar.${compression}`
  return {
    arch,
    compression,
    dirName,
    fileName,
    url: `https://nodejs.org/dist/${WSL_NODE_VERSION}/${fileName}`,
    sha256: SHA256[arch][compression],
  }
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex')
  } catch {
    return null
  }
}

export type NodeDownloadDeps = {
  /** Where verified archives are kept between runs (under userData). */
  cacheDir: string
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  /** The whole download, and the longest it may go without a byte. */
  totalTimeoutMs?: number
  stallTimeoutMs?: number
}

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const DOWNLOAD_STALL_MS = 60_000

/**
 * The verified archive on this PC's disk, downloading it if it is not there
 * yet. A cached file is re-hashed before it is trusted; a download that does
 * not match the pinned sum is deleted and reported, never used.
 */
export async function ensureWslNodeArchive(pkg: WslNodePackage, deps: NodeDownloadDeps): Promise<string> {
  const target = join(deps.cacheDir, pkg.fileName)
  if ((await sha256OfFile(target)) === pkg.sha256) return target
  await mkdir(deps.cacheDir, { recursive: true })
  const temp = `${target}.${randomBytes(4).toString('hex')}.part`
  const doFetch = deps.fetch ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init))
  // A download that stalls must not hold every launch on this machine
  // waiting: the whole thing has a deadline, and so does each silence.
  const controller = new AbortController()
  const total = setTimeout(
    () => controller.abort(new Error('the download took too long')),
    deps.totalTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  )
  let stall: ReturnType<typeof setTimeout> | null = null
  const stallMs = deps.stallTimeoutMs ?? DOWNLOAD_STALL_MS
  const armStall = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => controller.abort(new Error('the download stopped receiving data')), stallMs)
  }
  armStall()
  try {
    let response: Response
    try {
      response = await doFetch(pkg.url, { signal: controller.signal })
    } catch (error) {
      throw new WslSetupError(
        `Couldn't set up WSL: no network to download Node.js (${describe(error)}). WSL machines need it once, on first use.`,
        { fatal: true, code: 'node-download' },
      )
    }
    if (!response.ok || !response.body) {
      throw new WslSetupError(
        `Couldn't set up WSL: downloading Node.js failed (${response.status} ${response.statusText}).`,
        { fatal: true, code: 'node-download' },
      )
    }
    const hash = createHash('sha256')
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      armStall()
    })
    try {
      await pipeline(body, createWriteStream(temp))
    } catch (error) {
      throw new WslSetupError(`Couldn't set up WSL: the Node.js download was interrupted (${describe(error)}).`, {
        fatal: true,
        code: 'node-download',
      })
    }
    const digest = hash.digest('hex')
    if (digest !== pkg.sha256) {
      throw new WslSetupError(
        `Couldn't set up WSL: the Node.js download did not match its checksum (got ${digest.slice(0, 12)}…). ` +
          'Something between this PC and nodejs.org changed it.',
        { fatal: true, code: 'node-checksum' },
      )
    }
    await rename(temp, target)
    return target
  } finally {
    clearTimeout(total)
    if (stall) clearTimeout(stall)
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

function describe(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error instanceof Error ? error.message : String(error)}${cause}`
}
