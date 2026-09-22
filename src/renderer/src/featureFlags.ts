// Features that are still under active development stay available in source
// builds without being exposed in packaged releases. Keep these gates at the
// renderer boundary so the unfinished UI is absent rather than merely disabled.
export function featureFlagsForBuild(isProductionBuild: boolean): { conversationMode: boolean } {
  return {
    conversationMode: !isProductionBuild,
  }
}

export const FEATURE_FLAGS = Object.freeze(featureFlagsForBuild(import.meta.env.PROD === true))
