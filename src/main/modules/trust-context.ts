import {
  defaultMarketplacePluginInstallStorePath,
  readVerifiedModuleInstallsSync,
} from '../marketplace/plugin-lifecycle'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import type { ModuleTrustContext } from './module-signature'
import { readTrustedModulesSync } from './trust-store'

// Everything a third-party module's trust is decided against, read fresh from
// this machine: the user's grants, the trusted publisher keys, and the modules
// a verified marketplace install vouched for. One reader, so no caller can
// classify a module against part of it — a context missing the verified
// installs would refuse the first-party modules the marketplace put in place.
export function readModuleTrustContextSync(userDataDir: string): ModuleTrustContext {
  return {
    trustedModules: readTrustedModulesSync(userDataDir),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
    verifiedModuleInstalls: readVerifiedModuleInstallsSync(defaultMarketplacePluginInstallStorePath(userDataDir)),
  }
}
