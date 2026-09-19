import { buildStamp } from 'virtual:sprintengine-build-stamp'

// The renderer's half of the build-identity check. `buildStamp` is
// minted when this bundle is built, so it is the commit the *loaded document*
// came from — which is the whole point: after a merge into the tree a dev run is
// serving from, the window reloads onto the new commit while main keeps running
// the bundle it booted with. Main compares the two.
//
// Reported from every window: they all load this bundle, and a window opened
// later is an independent reading of the same question. Main deduplicates, so
// the operator is told once.
export function reportBuildStamp(): void {
  // Aux surfaces and tests can load this module without the bridge attached; a
  // diagnostic must never be the thing that breaks a boot.
  window.api?.reportBuildStamp?.(buildStamp)
}
