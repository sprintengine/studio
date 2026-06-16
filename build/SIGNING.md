# Code signing & notarization

The `build` config in `package.json` is wired for signed, notarized releases.
No certificates or secrets live in the repo — they are supplied at build time
via environment variables (locally or in CI). `npm run dist` will sign and
notarize automatically once these are set.

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
