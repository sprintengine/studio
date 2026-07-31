# Code signing & notarization

The `build` config in `package.json` is wired for signed, notarized releases.
No certificates or secrets live in the repo — they are supplied at build time
via environment variables (locally or in CI). `npm run dist` will sign and
notarize automatically once these are set.

## Current state (as of v0.2.0): NOTHING IS SIGNED

Read this before assuming a release is signed. As of the v0.2.0 release:

- The repo has **no GitHub Actions secrets at all** (`gh secret list` is empty).
- The workstation keychain holds only an **Apple Development** certificate, which
  is *not* a distribution identity — `Developer ID Application` is the one macOS
  needs, and it requires the **paid** Apple Developer Program.
- electron-builder does not fail when it finds no identity; it logs a skip and
  produces an **unsigned, un-notarized** artifact. Every release through v0.2.0
  therefore ships unsigned.

What users see today: macOS Gatekeeper blocks the app on first launch (the
right-click → Open workaround is required), and Windows SmartScreen warns on the
installer. Silent auto-update via `electron-updater` is also unreliable unsigned.

`.github/workflows/release.yml` already passes every variable below through to
the `Package app` step, so signing switches on by adding repository secrets —
no workflow edit is needed.

## Turning signing on

### macOS — order matters

`build.mac.notarize` is `true`. Adding a certificate *without* notarization
credentials yields a signed app that then **fails** at the notarize step, which
turns a previously-green release red. Add both halves in one change.

1. Enrol in the Apple Developer Program ($99/yr). Enrolment is not instant —
   identity verification commonly takes a day or more.
2. In Xcode (Settings → Accounts → Manage Certificates) or on
   developer.apple.com, create a **Developer ID Application** certificate.
   Confirm it landed: `security find-identity -v -p codesigning` must list an
   identity beginning `Developer ID Application:`, not just `Apple Development:`.
3. Export it from Keychain Access as a `.p12` with a password, then base64 it:
   `base64 -i cert.p12 | pbcopy`.
4. Create an app-specific password at appleid.apple.com (Sign-In and Security →
   App-Specific Passwords). This is **not** the Apple ID password.
5. Add four repository secrets:
   `CSC_LINK` (the base64 blob), `CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` (the 10-character team id;
   it is the `OU` field of the certificate subject).

The App Store Connect API key method (`APPLE_API_KEY` / `APPLE_API_KEY_ID` /
`APPLE_API_ISSUER`) also works and avoids a per-user password, but `APPLE_API_KEY`
is a *path* to a `.p8` file, so CI must write the secret to disk first. The
Apple ID method above needs no extra step, which is why the workflow wires it.

### Windows — plan for lead time

Microsoft no longer accepts self-service OV certificates on a local `.pfx`; the
key must live on a hardware token or in a cloud signing service. Two viable routes:

- **Azure Trusted Signing** (~$10/month) — no hardware, but the subscription must
  pass Microsoft's identity validation, and individual/new-org eligibility rules
  apply. Configure `build.win.azureSignOptions` and supply the `AZURE_*`
  credentials rather than `WIN_CSC_LINK`.
- **A CA (DigiCert / Sectigo / SSL.com)** — an OV or EV cert on a shipped USB
  token, roughly $300–600/yr. CI then needs a self-hosted runner or the CA's
  cloud-signing API, since a GitHub-hosted runner cannot reach a USB token.

Either way, budget **days to weeks** for validation. Neither can be completed on
the same day it is started, which is why v0.2.0 shipped unsigned.

## macOS (Developer ID + notarization)

`build.mac` enables `hardenedRuntime`, the entitlements in
`build/entitlements.mac.plist` / `build/entitlements.mac.inherit.plist`, and
`notarize: true`. Provide:

**Signing identity** (one of):
- `CSC_LINK` — path to (or base64 of) your `Developer ID Application` `.p12`
- `CSC_KEY_PASSWORD` — its password

(or have a valid `Developer ID Application` identity in the login keychain.)

**Notarization** (one of the two auth methods):

App Store Connect API key (recommended for CI):
- `APPLE_API_KEY` — path to the `.p8` key file
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

…or Apple ID:
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## Windows (Authenticode)

`build.win` targets NSIS. electron-builder signs automatically when a
certificate is provided:
- `CSC_LINK` / `WIN_CSC_LINK` — path to (or base64 of) the `.pfx`
- `CSC_KEY_PASSWORD` / `WIN_CSC_KEY_PASSWORD` — its password

> Note: Microsoft now requires OV/EV certificates issued to a hardware token
> or a cloud signing service. For Azure Trusted Signing, configure
> `build.win.azureSignOptions` and supply the corresponding `AZURE_*`
> credentials instead of a local `.pfx`.

## Publishing auto-updates

Releases publish to GitHub (`build.publish`) and are consumed by
`electron-updater`. Set `GH_TOKEN` with a token that can create releases on the
target repo. **Do not publish unsigned/un-notarized builds** — Gatekeeper and
SmartScreen will block them, and silent auto-update will fail.

## Quick check

```bash
# macOS, after a signed build:
codesign --verify --deep --strict --verbose=2 "dist/mac/Multicode.app"
spctl -a -t exec -vvv "dist/mac/Multicode.app"   # should report: accepted, Notarized Developer ID
```
