import { createElectronPlatform, type ElectronPlatformDeps } from '../src/main/platform/electron-platform'
import { installStudioPlatform, resetStudioPlatform } from '../src/server/platform/platform'
import * as electronStub from './stubs/electron'

// The suites that stand Electron in drive main-process code as the app runs
// it, which is after the entry has installed the Electron platform over the
// real `electron`. This installs the same platform over the suite's stand-in
// (the shared stub in `stubs/electron.ts` unless the suite has its own), so
// code that reads the platform sees the stand-in's `userData` and `isPackaged`
// exactly as code that still imports `electron` does.
//
// The platform looks each Electron member up only when it is used, so a
// stand-in needs only the members its suite reaches. Returns the reset.
export function installElectronPlatformOver(electron: object = electronStub): () => void {
  installStudioPlatform(createElectronPlatform(electron as ElectronPlatformDeps))
  return resetStudioPlatform
}
