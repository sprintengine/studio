import { createHash, randomBytes } from 'crypto';
export function randomBase64Url(byteLength) {
    return randomBytes(byteLength).toString('base64url');
}
export function hashSecret(secret) {
    return createHash('sha256').update(secret).digest('hex');
}
