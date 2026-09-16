# @sprintengine/mobile-control-protocol

The wire protocol spoken between **SprintEngine Studio** on the desktop and the
**SprintEngine companion** phone app: the command, event and snapshot types, the
runtime validators that guard them on receipt, and the protocol version window.

It is a single self-contained module with no imports — no Electron, no React
Native, no Node built-ins — because both ends have to be able to load it and
they have almost nothing else in common.

## Why it exists

Until 2026-09 this file was maintained as two byte-identical copies, one in each
repository, kept honest by a sha256 pin on both sides. The pin caught drift but
could not prevent it, and a copy that drifted between a desktop release and the
phone's store review shipped a real bug. A published package makes the two ends
share a compiled artifact instead of a convention.

## Install

```
npm install @sprintengine/mobile-control-protocol
```

## Use

```ts
import {
  mobileControlProtocolVersion,
  validateMobileControlCommand,
  type MobileControlCommand,
} from '@sprintengine/mobile-control-protocol'

const result = validateMobileControlCommand(payloadFromTheWire)
if (result.ok === false) {
  // result.error names both the version seen and the window this build accepts.
  return reject(result.error)
}
```

Validate, never cast. A `MobileControlCommand` type assertion on a payload that
arrived over the network is a claim about a remote peer's build, and the whole
point of the version window is that you cannot make that claim.

## Builds

The package ships both module formats, and both sets of declarations:

| Condition | Entry | Declarations |
|---|---|---|
| `import` | `dist/esm/index.js` | `dist/esm/index.d.ts` |
| `require` | `dist/cjs/index.js` | `dist/cjs/index.d.ts` |

Two builds because the two consumers load it two different ways. Studio bundles
ESM through electron-vite; the phone bundles ESM through Metro but compiles its
regression suite to CommonJS (`module: Node16`) and runs it on bare Node, which
reaches this package through `require`. `scripts/verify-mobile-protocol-pack.mjs`
in the Studio repository type-checks and runs a consumer of each kind against the
packed tarball.

## Versioning

**The npm major is the wire version.** `mobileControlProtocolVersion` is `4`, so
this package is `4.x.y`. That is not decoration: a wire bump changes which peers
are refused at the handshake, which is a breaking change for everything that
depends on this package, and semver already has a number for that.

| Change | What moves |
|---|---|
| Wire version bump (a field changes meaning or type, or is removed) | major, in lockstep with `mobileControlProtocolVersion` |
| Additive: a new capability, command, event, or optional field | minor |
| A validator fix, or a comment, that does not change what crosses the wire | patch |

The major is reserved for the wire, which means a source-only breaking change —
renaming an exported type, say — has no number of its own. Do it as a minor with
the old name kept as a deprecated alias. Consumers of a protocol cannot absorb
two independent axes of breakage, and the bytes are the axis that matters.

`docs/compatibility.md` in the Studio repository is the policy for the version
window itself: what obliges a bump, what a capability flag covers instead, and
every enforcement site that has to agree.

## Licence

MIT. See `LICENSE`.
