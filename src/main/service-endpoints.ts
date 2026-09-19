// The two public deployments a stock build talks to, in one place.
//
// Each has three layers, most specific first:
//   1. runtime env — `MULTIAUTH_BASE_URL` / `SPRINTENGINE_MOBILE_RELAY_URL`, read
//      at the use site, so a developer can point a running app anywhere;
//   2. build-time env — the same two names set when `electron-vite build` runs,
//      baked in through the `define` block in `electron.vite.config.ts`, so a
//      fork ships pointing at its own account service without patching source;
//   3. the literal defaults below — the deployments the released app reaches.
//
// The defaults stay: the published app has to be able to find the relay out of
// the box. `typeof` guards each define because the constants exist only in a
// bundled build — under the test runner the identifiers are undeclared.

// Both services are currently one deployment; they are separate constants so a
// fork can split them without touching either call site.
const FALLBACK_ACCOUNT_SERVICE_URL = 'https://multiauth-production.up.railway.app'

/** Default account service base URL; override with `MULTIAUTH_BASE_URL`. */
export const DEFAULT_MULTIAUTH_BASE_URL =
  typeof __MULTIAUTH_BASE_URL__ === 'string' && __MULTIAUTH_BASE_URL__
    ? __MULTIAUTH_BASE_URL__
    : FALLBACK_ACCOUNT_SERVICE_URL

/** Default mobile relay base URL; override with `SPRINTENGINE_MOBILE_RELAY_URL`. */
export const DEFAULT_MOBILE_RELAY_URL =
  typeof __MOBILE_RELAY_URL__ === 'string' && __MOBILE_RELAY_URL__ ? __MOBILE_RELAY_URL__ : FALLBACK_ACCOUNT_SERVICE_URL
