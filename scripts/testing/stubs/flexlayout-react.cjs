// Test-only stub for flexlayout-react.
//
// A few node-side render suites (bundled-ids, automation-report-viewer,
// automation-run-actions) pull flexlayout-react *transitively* — a UI import
// reaches `components/AppIcons.tsx`, which imports the module registry
// (`modules/index.ts`), which drags in the workspace store and
// `utils/modelRegistry.ts` (the only value-level flexlayout consumer). Those
// suites never exercise layout behaviour, but they bundle with
// `--packages=external`, so the transitive `require("flexlayout-react")`
// executes at load. flexlayout-react ships no "exports" main, so Node >= 25
// cannot resolve it as an external and the suite crashes before any assertion.
//
// Aliasing flexlayout-react to this stub for exactly those suites lets them load
// again. The app's real vite build bundles flexlayout-react normally, so no
// product behaviour is affected; suites that genuinely test layout state import
// flexlayout directly under `--packages=bundle` and never hit this stub.
//
// Every value-level export the app imports is an **own property** here, not
// only a Proxy `get` trap. esbuild turns `import { DockLocation } from …` into a
// namespace built by `__toESM`, which copies own enumerable keys — a symbol that
// exists only behind a `get` trap is absent from that namespace and reads back
// as `undefined`. That is invisible while a symbol is dereferenced inside a
// function, and a load-time crash the moment one is read at module scope (as
// `modelRegistry.ts`'s rail table reads `DockLocation.LEFT`).
//
// `DockLocation` therefore carries its real member names. The classes stay
// no-ops: these suites never construct a layout, they only need the module to
// load. The Proxy is kept for anything not listed, so an export added later
// still resolves for a plain `require()` consumer rather than throwing.
const Noop = class {}
const exported = {
  __esModule: true,
  Actions: Noop,
  DockLocation: { LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom', CENTER: 'center' },
  Layout: Noop,
  Model: Noop,
  Rect: Noop,
  RowNode: Noop,
  TabNode: Noop,
  TabSetNode: Noop,
}
module.exports = new Proxy(exported, {
  get: (target, prop) => (prop in target ? target[prop] : Noop),
})
