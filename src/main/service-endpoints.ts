// The public deployment a stock build talks to: the account service, for
// sign-in and entitlements. The phone companion is not on this list: it reaches
// the desktop over the tailnet, never through a hosted service.
//
// Three layers, most specific first:
//   1. runtime env — `MULTIAUTH_BASE_URL`, read at the use site, so a developer
//      can point a running app anywhere;
//   2. build-time env — the same name set when `electron-vite build` runs,
//      baked in through the `define` block in `electron.vite.config.ts`, so a
//      fork ships pointing at its own account service without patching source;
//   3. the literal default below — the deployment the released app reaches.
//
// The default stays: the published app has to be able to sign in out of the
// box. `typeof` guards the define because the constant exists only in a
// bundled build — under the test runner the identifier is undeclared.
const FALLBACK_ACCOUNT_SERVICE_URL = 'https://multiauth-production.up.railway.app'

/** Default account service base URL; override with `MULTIAUTH_BASE_URL`. */
export const DEFAULT_MULTIAUTH_BASE_URL =
  typeof __MULTIAUTH_BASE_URL__ === 'string' && __MULTIAUTH_BASE_URL__
    ? __MULTIAUTH_BASE_URL__
    : FALLBACK_ACCOUNT_SERVICE_URL
