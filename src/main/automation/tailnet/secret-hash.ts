import { createHash, timingSafeEqual } from 'crypto'

/**
 * The SHA-256 hex digest a tailnet or local-app secret is stored and compared as.
 *
 * Device tokens, pairing codes and the pair-request collect secret are never
 * kept in the clear: the device store holds this digest and compares a
 * presented secret by hashing it the same way. One function, so the writer and
 * every reader agree on the encoding.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Constant-time comparison of two hex digests; length-mismatch short-circuits safely. */
export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
