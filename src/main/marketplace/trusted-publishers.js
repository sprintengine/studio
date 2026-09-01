import { readFileSync } from 'node:fs';
import { findMarketplaceResourcePath } from './resources';
export function readTrustedMarketplacePublisherFingerprintsSync() {
    const path = findMarketplaceResourcePath('trusted-publishers.json');
    if (!path)
        return new Set();
    try {
        const payload = JSON.parse(readFileSync(path, 'utf8'));
        return new Set((payload.publishers ?? [])
            .map((publisher) => publisher.fingerprint)
            .filter((fingerprint) => typeof fingerprint === 'string' && fingerprint.trim().length > 0)
            .map((fingerprint) => fingerprint.trim()));
    }
    catch {
        return new Set();
    }
}
