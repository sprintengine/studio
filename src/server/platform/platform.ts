import { join } from 'node:path'

import { createStaticAppIdentity, type AppIdentity } from './app-identity'
import { createLocalClientBus, type LocalClientBus, type ClientBus } from './client-bus'
import { createLocalNotifier, type LocalNotifier, type Notifier } from './notifier'
import { createKeyFileSecretCipher, type SecretCipher } from './secret-cipher'
import { createNodeStudioPaths, type NodeStudioPathsOptions, type StudioPaths } from './studio-paths'

// Everything server-bound code used to take from Electron, behind five small
// interfaces. The process that hosts the server installs one platform before it
// builds anything: Electron main installs `createElectronPlatform`
// (src/main/platform/electron-platform.ts) as the first thing its entry does,
// and a standalone server installs `createNodeStudioPlatform`.
//
// Stores and services that are constructed take their piece as an option and
// fall back to the installed platform; the few free functions deep in the call
// graph (resource lookups, the shared credential store) read the installed one
// when they are called. Neither reads it while a module is being imported.

export type StudioPlatform = {
  paths: StudioPaths
  secrets: SecretCipher
  clients: ClientBus
  notifier: Notifier
  identity: AppIdentity
}

let installed: StudioPlatform | null = null

/** Install the process's platform. Called once, by the entry, before anything is built. */
export function installStudioPlatform(platform: StudioPlatform): void {
  installed = platform
}

/** The installed platform. Throws when none is: a missing install is a wiring bug, not a state to degrade through. */
export function studioPlatform(): StudioPlatform {
  if (!installed) {
    throw new Error('No Studio platform is installed. The entry installs one before it builds any service.')
  }
  return installed
}

/**
 * The installed platform, or null. Only for the call sites that already treated
 * "not running inside Electron" as a state of their own (a launch env that
 * omits a socket address, a store that keeps tokens in memory), so a plain-Node
 * test of them behaves exactly as it did before the platform existed.
 */
export function installedStudioPlatform(): StudioPlatform | null {
  return installed
}

/** Forget the installed platform; tests that install one put the process back. */
export function resetStudioPlatform(): void {
  installed = null
}

export type NodeStudioPlatform = StudioPlatform & { clients: LocalClientBus; notifier: LocalNotifier }

export type NodeStudioPlatformOptions = NodeStudioPathsOptions & {
  version: string
  /** Defaults to an owner-only key file in `<dataDir>/run/`. */
  secrets?: SecretCipher
}

/** The platform a standalone server runs on (and the one tests that need a platform install). */
export function createNodeStudioPlatform(options: NodeStudioPlatformOptions): NodeStudioPlatform {
  return {
    paths: createNodeStudioPaths(options),
    secrets: options.secrets ?? createKeyFileSecretCipher({ keyPath: join(options.dataDir, 'run', 'secret-key') }),
    clients: createLocalClientBus(),
    notifier: createLocalNotifier(),
    identity: createStaticAppIdentity({ version: options.version }),
  }
}
