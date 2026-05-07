import { createHash, randomBytes } from 'crypto'

export function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
