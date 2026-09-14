# Adopting the mobile protocol package in the phone app

The mobile-control wire schema used to exist twice: once here and once in the
phone app's repository, byte-identical, with a sha256 pinned on both sides to
catch them drifting apart. The pin caught drift; it could not prevent it, and a
copy that drifted between a desktop release and the phone's store review shipped
a real bug.

It now exists once, in `packages/mobile-control-protocol`, published as
**`@sprintengine/mobile-control-protocol`**. This desktop compiles it from
source. The phone installs it from npm.

This file is the phone side of that change. Nothing here has been done to the
phone's repository — it is a set of instructions for whoever does it there.

## What the phone gets

A package that ships both module formats and both sets of declarations:

| Condition | Entry | Declarations |
|---|---|---|
| `import` | `dist/esm/index.js` | `dist/esm/index.d.ts` |
| `require` | `dist/cjs/index.js` | `dist/cjs/index.d.ts` |

Both matter to the phone, and for different reasons. Metro bundles the app from
the ESM build. `npm run test:mobile` compiles `tsconfig.test.json` with
`module: Node16` into `.mobile-test-build` and runs the output on bare Node,
which reaches the package through `require` — a package that shipped ESM only
would type-check there and then fail at load time, in a place that looks like a
test-harness problem rather than a packaging one.

Both paths are checked here, against the packed tarball rather than the source
tree, by `scripts/verify-mobile-protocol-pack.mjs`. The CommonJS half of that
check compiles with exactly the phone's `tsconfig.test.json` settings.

## The order of operations

The steps have to happen in this order, and steps 3 and 4 are separated by a
store review that nobody controls.

**1. Publish the package from this repository.** Nothing on the phone side can
start before the version exists on npm. See "Publishing" below.

**2. In the phone repository, add the dependency and switch the imports.**

`package.json`:

```json
"dependencies": {
  "@sprintengine/mobile-control-protocol": "^2.0.0"
}
```

The caret is deliberate. Within a major, every change is additive or a validator
fix, so a newer `2.x` is always safe to pick up; a new major means the wire
version moved, which is a decision the phone has to make on purpose rather than
inherit from a lockfile refresh. See `docs/compatibility.md`.

Then delete `src/shared/mobile-control/protocol.ts`. As of this writing the
repository reaches it from five places, and they are not all the same edit:

- `src/features/web/webTargetsLogic.ts` imports two types from it. Change the
  specifier and nothing else:

  ```diff
  -import type { MobileControlSnapshot } from "../../shared/mobile-control/protocol";
  +import type { MobileControlSnapshot } from "@sprintengine/mobile-control-protocol";
  ```

  The export names are unchanged — the module was extracted verbatim, not
  rewritten — so every import is a specifier change and nothing else.

- `tsconfig.test.json` lists `src/shared/mobile-control/protocol.ts` among its
  entry points. Remove that line: the package is a dependency now, not a source
  file this build compiles, and leaving it listed fails on a missing file.

- `src/features/sprints/sprintHubLogic.regression.test.js` and
  `src/shared/mobile-control/mobileControlProtocol.regression.test.js` both
  `require(path.join(buildRoot, "src/shared/mobile-control/protocol.js"))`.
  That path stops existing once the entry point is gone. Both should require
  the package by name instead — they run on Node, and the package's `require`
  condition is built for exactly that.

- `src/components/glyphs/roleRegistry.regression.test.js` only names the old
  path in a comment. Point it at the package.

**3. Replace the pin test with a resolution test.** The phone's
`src/shared/mobile-control/mobileControlProtocol.regression.test.js` hashes its
local `protocol.ts` and compares it to a constant. There is no longer a local
file to hash, so that assertion has to go — but do not simply delete the test.
Its behavioural half (the validator cases below the pin) is still worth running,
and it should now also assert what replaces the pin:

```js
const protocol = require("@sprintengine/mobile-control-protocol");
const manifest = require("@sprintengine/mobile-control-protocol/package.json");

test("the installed protocol package speaks the wire version this build expects", () => {
  assert.equal(Number(manifest.version.split(".")[0]), protocol.mobileControlProtocolVersion);
  assert.equal(protocol.mobileControlProtocolVersion, 2);
});
```

That is a weaker claim than the hash and a more useful one. The hash proved two
files were identical; this proves the build resolved a package whose wire version
is the one the phone was written against, which is the fact the hash was standing
in for. Drift is now impossible rather than merely detectable, so the guard's job
shrinks to catching a botched install or an unintended major bump.

Keep the literal `2` spelled out. A test that only compares the package to
itself passes no matter which version got installed.

**4. Ship, and only then retire the desktop guard.** Until a released phone
build depends on the package, the phone's `protocol.ts` is still live on every
installed handset, and the drift guard in
`src/main/mobile/sprintengine/snapshot.test.ts` is still the only thing standing
between it and this desktop. Leave it alone until the store build is out.

The extraction kept the file byte-identical on purpose — the pinned hash is the
same value it was before — so that guard survived the move unchanged and still
compares the phone's untouched copy against what this desktop now compiles.

When the phone has shipped, delete `assertMobileProtocolCopyHasNotDrifted`, its
pinned constant and its call site from `snapshot.test.ts`, and update step 5 of
`docs/compatibility.md`.

## Publishing

From this repository, with an npm account that can publish under the
`@sprintengine` scope:

```
npm run test:mobile-protocol:pack          # builds, packs, and proves both consumers resolve
npm publish --access public ./packages/mobile-control-protocol
```

`--access public` is required: the `@sprintengine` scope defaults to a private
publish, which would succeed and produce a package the phone's CI cannot install.

`npm publish` runs the package's `prepack`, which rebuilds `dist/` from source,
so the tarball that goes to the registry is always built from what is committed
rather than from whatever was last left on disk.

Before publishing a version after the first, bump
`packages/mobile-control-protocol/package.json` and add a `CHANGELOG.md` entry.
What to bump is in `docs/compatibility.md` under "The wire version and the npm
version"; the short form is that the major is the wire version and everything
else is a minor or a patch.
