import { posix } from 'node:path'

import type { StudioClient } from '../../../packages/agent-sdk/src/client'
import { StudioError } from '../../../packages/agent-sdk/src/errors'
import {
  STUDIO_UPLOAD_CHUNK_BYTES,
  type StudioFileEntry,
  type StudioFileRoot,
  type StudioFileStat,
} from '../../../packages/studio-protocol/src/public'
import type { CanvasDirectoryWatcher, CanvasFs, CanvasPathApi } from './canvas-service'

// The canvas service's filesystem over a Studio's `files.*`: the service runs
// in the client (it is the shell's `canvas` toolset), and the boards stay on
// the server's disk, read, written and watched through the protocol.
//
// The service runs on `path.posix` over two virtual roots per workspace,
// `/workspace/<workspaceId>/` and `/boards/<workspaceId>/`, which this maps to
// a root and a relative path; so its own path logic is unchanged, and a
// Windows desktop driving a Linux server never mixes separators.
//
// A board is written whole with one conditional `files.write`
// (`writeFileAtomic`), never as a temp file and a rename of the client's own:
// the server's writer is atomic and leaves no temp behind. A board too large
// for one frame is staged with `uploads.*` first.

export type ProtocolCanvasClient = Pick<StudioClient, 'request' | 'subscribe'>

/** Where a workspace's two roots are, as the service names them. */
export function protocolCanvasRoots(workspaceId: string): { workspace: string; boards: string } {
  return { workspace: `/workspace/${workspaceId}`, boards: `/boards/${workspaceId}` }
}

/** A virtual path as a root and a path relative to it, or null for one outside both roots. */
export function protocolCanvasLocation(path: string): { root: StudioFileRoot; path: string } | null {
  const normalised = posix.normalize(path)
  const [empty, kind, workspaceId, ...rest] = normalised.split('/')
  if (empty !== '' || (kind !== 'workspace' && kind !== 'boards') || !workspaceId) return null
  return { root: { kind, workspaceId }, path: rest.filter(Boolean).join('/') }
}

function enoent(path: string, message = 'no such file or directory'): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${message}, '${path}'`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

// Text up to this goes in the write itself; above it, its bytes are uploaded first.
const INLINE_TEXT_BYTES = 768 * 1024

function newCommandId(): string {
  return `canvas-${globalThis.crypto.randomUUID()}`
}

export type ProtocolCanvasFs = {
  fs: CanvasFs
  path: CanvasPathApi
  watch(directory: string, onChange: (filename: string | null) => void): CanvasDirectoryWatcher
  /** A workspace's folder, as the service resolves it: its virtual root. */
  resolveWorkspaceRoot(workspaceId: string): string
  /** A workspace's board store, as the service resolves it: its virtual root. */
  resolveBoardStore(workspaceId: string): string
}

export function createProtocolCanvasFs(
  client: ProtocolCanvasClient,
  options: {
    /**
     * Tell this filesystem when its client connected again, so every watched
     * folder is read once more: a change made while it was away is not missed.
     */
    onReconnect?: (listener: () => void) => () => void
  } = {},
): ProtocolCanvasFs {
  const locate = (path: string) => {
    const location = protocolCanvasLocation(path)
    if (!location) throw enoent(path, 'outside every root this Studio serves')
    return location
  }
  /** A request, with the protocol's not-found read as a missing file, as Node's fs says it. */
  async function ask<T>(path: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof StudioError && error.code === 'not_found') throw enoent(path)
      throw error
    }
  }

  async function stat(path: string): Promise<StudioFileStat> {
    const { root, path: relative } = locate(path)
    const answer = await ask(path, () => client.request('files.stat', { root, path: relative }))
    return answer.stat as unknown as StudioFileStat
  }

  async function upload(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    const begun = await client.request('uploads.begin', {
      mediaType: 'application/json',
      byteLength: bytes.length,
      purpose: 'file',
    })
    const chunk = Math.min(begun.chunkBytes || STUDIO_UPLOAD_CHUNK_BYTES, STUDIO_UPLOAD_CHUNK_BYTES)
    try {
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        const piece = bytes.subarray(offset, offset + chunk)
        await client.request('uploads.append', {
          uploadId: begun.uploadId,
          offset,
          dataBase64: Buffer.from(piece).toString('base64'),
        })
      }
    } catch (error) {
      discard(begun.uploadId)
      throw error
    }
    return begun.uploadId
  }

  /** Give back staged bytes no write will spend, so they stop counting against the connection. */
  function discard(uploadId: string): void {
    void client.request('uploads.discard', { uploadIds: [uploadId] }).catch(() => undefined)
  }

  async function write(path: string, text: string, ifMatch: string | null) {
    const { root, path: relative } = locate(path)
    const uploadId = Buffer.byteLength(text, 'utf8') <= INLINE_TEXT_BYTES ? null : await upload(text)
    const body = uploadId === null ? { text } : { uploadId }
    try {
      return await ask(path, () =>
        client.request('files.write', { root, path: relative, ...body, ifMatch, commandId: newCommandId() }),
      )
    } catch (error) {
      // A write that was not carried out leaves its upload unsent.
      if (uploadId !== null) discard(uploadId)
      throw error
    }
  }

  const fs: CanvasFs = {
    async readFile(path) {
      const { root, path: relative } = locate(path)
      const read = await ask(path, () => client.request('files.read', { root, path: relative }))
      return read.text
    },
    async writeFileAtomic(path, contents, { ifMatch }) {
      const written = await write(path, contents, ifMatch)
      return written.ok ? { ok: true } : { ok: false, conflict: true }
    },
    // Unconditional, for a caller that writes without a board's history: what
    // is there now is what it replaces.
    async writeFile(path, contents) {
      let current: string | null = null
      try {
        current = (await stat(path)).hash ?? null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const written = await write(path, contents, current)
      if (!written.ok) throw new Error(`${path} changed while it was being written.`)
    },
    async rename(from) {
      throw new Error(`A Studio's files are written in place; ${from} cannot be renamed over the protocol.`)
    },
    // The server creates a written file's folders.
    async mkdir() {},
    async stat(path) {
      const found = await stat(path)
      return {
        size: found.size,
        mtimeMs: found.mtimeMs,
        isDirectory: found.kind === 'directory',
        isFile: found.kind === 'file',
      }
    },
    async readdir(path) {
      const { root, path: relative } = locate(path)
      const listed = await ask(path, () => client.request('files.list', { root, path: relative }))
      return (listed.entries as StudioFileEntry[]).map((entry) => ({
        name: entry.name,
        isDirectory: entry.kind === 'directory',
        isFile: entry.kind === 'file',
      }))
    },
    async unlink(path) {
      const { root, path: relative } = locate(path)
      let current: string | null = null
      try {
        current = (await stat(path)).hash ?? null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw enoent(path)
        throw error
      }
      const removed = await ask(path, () =>
        client.request('files.remove', { root, path: relative, ifMatch: current, commandId: newCommandId() }),
      )
      if (!removed.ok) throw new Error(`${path} changed while it was being removed.`)
    },
  }

  return {
    fs,
    path: posix,
    resolveWorkspaceRoot: (workspaceId) => protocolCanvasRoots(workspaceId).workspace,
    resolveBoardStore: (workspaceId) => protocolCanvasRoots(workspaceId).boards,
    watch(directory, onChange) {
      const { root, path } = locate(directory)
      const stop = client.subscribe(
        'files.watch',
        { root, path },
        {
          onPayload(payload) {
            const names = (payload as { names?: unknown }).names
            if (!Array.isArray(names)) return
            for (const name of names) onChange(typeof name === 'string' && name ? name : null)
          },
        },
      )
      // Back after a drop: the folder is read once more, for whatever changed while away.
      const unhear = options.onReconnect?.(() => onChange(null)) ?? (() => undefined)
      return {
        close: () => {
          stop()
          unhear()
        },
      }
    },
  }
}
