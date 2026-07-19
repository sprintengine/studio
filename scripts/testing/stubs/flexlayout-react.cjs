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
// The Proxy returns a harmless no-op class for every accessed symbol
// (Actions, DockLocation, Model, RowNode, TabNode, TabSetNode, …), so any
// bundle that references a flexlayout export loads without throwing; the value
// is never called on these code paths.
const Noop = class {}
module.exports = new Proxy(
  { __esModule: true },
  { get: (target, prop) => (prop in target ? target[prop] : Noop) },
)
