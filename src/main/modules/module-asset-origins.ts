import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MODULE_ASSET_SCHEME } from '../../shared/modules/assets'

/** Private installation capability, never placed inside a publicly served package.
 * Stable across launches so IndexedDB saves retain their origin. Module ids alone
 * cannot reveal an asset URL to an unrelated page or worker.
 */
export function createModuleAssetOriginResolver(userData: string): (moduleId: string) => string {
  mkdirSync(userData, { recursive: true })
  const secretPath = join(userData, 'module-asset-origin-secret')
  let secret: Buffer
  try { secret = readFileSync(secretPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { writeFileSync(secretPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
    }
    secret = readFileSync(secretPath)
  }
  if (secret.length !== 32) throw new Error('Invalid module asset origin secret.')
  return (moduleId) => `${MODULE_ASSET_SCHEME}://${createHmac('sha256', secret).update(moduleId).digest('hex')}`
}
