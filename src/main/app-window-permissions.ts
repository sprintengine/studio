// What the app's own windows may be granted when a page in them asks.
//
// The handlers stay installed even though the app asks for almost nothing: a
// session with no permission request handler grants every request, so dropping
// them would hand the microphone and camera to whatever the window loads.
//
// The one request answered yes is a `media` request that names no capture
// device. That is how `getDisplayMedia` arrives — Chromium routes it through
// the permission handler first, with an empty `mediaTypes` — and the browser
// pane records a tab that way (`browser/recording-encoder.ts`), whose
// display-media handler then grants only the capture it armed. A request for
// the microphone or the camera names `audio` or `video` and is refused.

type PermissionDetails = { mediaTypes?: ReadonlyArray<string> }

export function allowAppWindowPermissionRequest(permission: string, details: PermissionDetails | undefined): boolean {
  return permission === 'media' && (details?.mediaTypes ?? []).length === 0
}
