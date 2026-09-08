// Tier 2 third-party capability module: manifest spec + validator.
//
// The validator and the canonical signing payload live in the published SDK
// (packages/module-sdk/src/manifest-validate.ts) so the app and the
// `multicode-module` CLI validate and sign/verify the exact same way; this
// module re-exports them for app code. See the SDK module for the rules
// (forced `source: 'third-party'`, stripped `core`, strict untrusted-input
// validation).

export {
  canonicalManifestPayload,
  parseThirdPartyModuleManifest,
  validateThirdPartyModuleManifest,
} from '../../../packages/module-sdk/src/manifest-validate'
