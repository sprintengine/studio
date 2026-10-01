import { randomUUID } from 'node:crypto'

import {
  STUDIO_MAX_UPLOAD_BYTES,
  STUDIO_MAX_UPLOADS_PER_SEND,
  STUDIO_UPLOAD_CHUNK_BYTES,
} from '../../../packages/studio-protocol/src/public'

// Pictures a client sends ahead of the `session.send` that carries them. A
// frame holds about a megabyte and a picture may be five, so the bytes come in
// `uploads.append` pieces, and the send names the finished uploads by id.
//
// Uploads belong to the client that made them (its grant's id, so a window
// that reconnects still holds what it staged), live ten minutes, and are
// bounded per client by count and by bytes: as many as one send may carry, at
// the largest size each may be. A send spends its uploads under its command
// id, and a retry of that same command finds them again for a minute, so a
// send repeated after a dropped connection is answered from the runtime's
// receipt rather than refused for pictures it already sent.

const UPLOAD_TTL_MS = 10 * 60_000
const SPENT_GRACE_MS = 60_000
const MAX_OPEN_UPLOADS = STUDIO_MAX_UPLOADS_PER_SEND * 2
const MAX_STAGED_BYTES = STUDIO_MAX_UPLOADS_PER_SEND * STUDIO_MAX_UPLOAD_BYTES

type Upload = {
  id: string
  owner: string
  mediaType: string
  name?: string
  byteLength: number
  chunks: Buffer[]
  received: number
  at: number
  spentBy?: { commandId: string; at: number }
}

export type StudioUploadRefusal = {
  ok: false
  code: 'invalid_params' | 'not_found' | 'busy' | 'too_large'
  message: string
}

/** A finished picture, as a send hands it to the runtime. */
export type StudioUploadedPicture = { uploadId: string; mediaType: string; name?: string; bytes: Buffer }

export type StudioUploads = {
  begin(
    owner: string,
    input: { mediaType: string; byteLength: number; name?: string },
  ): { ok: true; uploadId: string; chunkBytes: number } | StudioUploadRefusal
  append(
    owner: string,
    input: { uploadId: string; offset: number; dataBase64: string },
  ): { ok: true; received: number } | StudioUploadRefusal
  /** The finished uploads a send names, spent under its command id. */
  spend(
    owner: string,
    uploadIds: string[],
    commandId: string,
  ): { ok: true; pictures: StudioUploadedPicture[] } | StudioUploadRefusal
  /** How many uploads are held, for tests. */
  size(): number
}

export function createStudioUploads(options: { now?: () => number } = {}): StudioUploads {
  const now = options.now ?? Date.now
  const uploads = new Map<string, Upload>()

  function sweep(): void {
    const at = now()
    for (const [id, upload] of uploads) {
      if (upload.spentBy ? at - upload.spentBy.at > SPENT_GRACE_MS : at - upload.at > UPLOAD_TTL_MS) uploads.delete(id)
    }
  }
  const owned = (owner: string) => [...uploads.values()].filter((upload) => upload.owner === owner && !upload.spentBy)
  const find = (owner: string, uploadId: string): Upload | StudioUploadRefusal => {
    const upload = uploads.get(uploadId)
    // Another client's upload is not found, rather than refused: its id says nothing to this one.
    if (!upload || upload.owner !== owner)
      return {
        ok: false,
        code: 'not_found',
        message: 'That upload is not here; it may have expired. Send the picture again.',
      }
    return upload
  }

  return {
    begin(owner, input) {
      sweep()
      const open = owned(owner)
      if (open.length >= MAX_OPEN_UPLOADS)
        return { ok: false, code: 'busy', message: 'Too many pictures are waiting to be sent from this client.' }
      if (open.reduce((total, upload) => total + upload.byteLength, 0) + input.byteLength > MAX_STAGED_BYTES)
        return {
          ok: false,
          code: 'too_large',
          message: 'The pictures waiting to be sent are already as large as one send may carry.',
        }
      const id = randomUUID()
      uploads.set(id, {
        id,
        owner,
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
        byteLength: input.byteLength,
        chunks: [],
        received: 0,
        at: now(),
      })
      return { ok: true, uploadId: id, chunkBytes: STUDIO_UPLOAD_CHUNK_BYTES }
    },

    append(owner, input) {
      sweep()
      const upload = find(owner, input.uploadId)
      if ('ok' in upload) return upload
      if (upload.spentBy) return { ok: false, code: 'invalid_params', message: 'That picture was already sent.' }
      const bytes = Buffer.from(input.dataBase64, 'base64')
      // The same piece again (a request resent after a dropped connection) is
      // answered, not appended twice.
      if (input.offset + bytes.length <= upload.received && input.offset < upload.received)
        return { ok: true, received: upload.received }
      if (input.offset !== upload.received)
        return {
          ok: false,
          code: 'invalid_params',
          message: `Expected the bytes from ${upload.received}, not ${input.offset}.`,
        }
      if (bytes.length > STUDIO_UPLOAD_CHUNK_BYTES || upload.received + bytes.length > upload.byteLength)
        return { ok: false, code: 'too_large', message: 'More bytes than the upload said it would carry.' }
      upload.chunks.push(bytes)
      upload.received += bytes.length
      upload.at = now()
      return { ok: true, received: upload.received }
    },

    spend(owner, uploadIds, commandId) {
      sweep()
      const found: Upload[] = []
      for (const uploadId of uploadIds) {
        const upload = find(owner, uploadId)
        if ('ok' in upload) return upload
        if (upload.spentBy && upload.spentBy.commandId !== commandId)
          return {
            ok: false,
            code: 'invalid_params',
            message: 'A picture in this send was already sent with another message.',
          }
        if (upload.received !== upload.byteLength)
          return { ok: false, code: 'invalid_params', message: 'A picture in this send has not finished uploading.' }
        found.push(upload)
      }
      const at = now()
      for (const upload of found) upload.spentBy = { commandId, at }
      return {
        ok: true,
        pictures: found.map((upload) => ({
          uploadId: upload.id,
          mediaType: upload.mediaType,
          ...(upload.name === undefined ? {} : { name: upload.name }),
          bytes: upload.chunks.length === 1 ? upload.chunks[0] : Buffer.concat(upload.chunks),
        })),
      }
    },

    size: () => uploads.size,
  }
}
