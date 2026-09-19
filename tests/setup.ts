// Runs in every test worker before each test file.
import { afterEach, vi } from 'vitest'

// The app exports its own SPRINTENGINE_* / MULTICODE_* variables into every
// terminal it opens, and this repository is developed in the app — so a suite
// started from a Studio terminal would inherit a user-data dir, an agent id and
// a state socket that a CI shell never has. A test that needs one of these
// sets it itself; none may depend on which shell ran the suite.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SPRINTENGINE_') || name.startsWith('MULTICODE_')) delete process.env[name]
}

// `DEV` is false, as the app's own build compiles it; Vitest's default is a dev
// build. `PROD` is left false on purpose: the renderer keys its production
// channel on `PROD === true`, so the full module set stays active under test.
// The one suite that checks the production channel sets it itself.
vi.stubEnv('DEV', false)

// Node defines `navigator` as a getter-only global. The suites that stand up a
// JSDOM assign `globalThis.navigator = dom.window.navigator`; under the old
// sloppy-mode CommonJS bundles that assignment was silently dropped, and in
// strict ESM it throws. Writable, it now does what those suites always meant.
Object.defineProperty(globalThis, 'navigator', {
  value: globalThis.navigator,
  writable: true,
  configurable: true,
})

// Most suites predate Vitest and report failure the way a plain Node script
// does. `process.exit(n)` is already a failure under Vitest; `process.exitCode`
// is not, so a test that sets it fails here instead of passing silently.
afterEach(() => {
  const code = process.exitCode
  if (code !== undefined && code !== 0 && code !== '0') {
    process.exitCode = 0
    throw new Error(`the test set process.exitCode = ${String(code)}; see its output above`)
  }
})
