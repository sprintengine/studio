// Dev-only capability modules.
//
// These modules are available only in from-source development builds. In a
// packaged/installed (production) build they are excluded from the registration
// universe entirely — their main IPC/services/sidecars never register, their
// renderer panels/commands/settings sections/workspace modes never mount, and
// they never appear in the Settings → Modules manager or any profile. This is a
// hard gate: a packaged build has no env var or setting that re-enables them.
//
// The build channel (source vs packaged) decides whether this list is excluded;
// see `src/main/index.ts` (`!app.isPackaged`) and
// `src/renderer/src/modules/index.ts` (`import.meta.env.DEV`). Editing this list
// is the per-feature control — the channel is the single on/off switch.
//
// IMPORTANT: this only narrows the *active/registered* set. It must NOT narrow
// `BUNDLED_MODULE_IDS` (the reserved-id, anti-impersonation set in
// `manifest.ts`) — a third-party module must never be able to claim these ids,
// even in a build where the feature is absent.
export const DEV_ONLY_MODULE_IDS: readonly string[] = [
  'switchboard', // Switchboard & Watchtower (Watchtower rides inside this module)
  'mobile-relay',
  'voice-dictation', // Voice module
  'roadmap', // not production-ready yet; remove from this list to release
  'review', // not production-ready yet; remove from this list to release
]

const DEV_ONLY_MODULE_ID_SET: ReadonlySet<string> = new Set(DEV_ONLY_MODULE_IDS)

export function isDevOnlyModule(id: string): boolean {
  return DEV_ONLY_MODULE_ID_SET.has(id)
}

/**
 * Filter a list of modules (or manifests) down to those active for the build
 * channel. In a dev build everything is kept; in a production build the dev-only
 * modules are dropped. Generic over anything exposing a module id so it serves
 * both `CapabilityModule[]` (via accessor) and `CapabilityManifest[]`.
 */
export function activeForChannel<T>(
  items: readonly T[],
  getId: (item: T) => string,
  includeDevOnly: boolean
): T[] {
  if (includeDevOnly) return [...items]
  return items.filter((item) => !isDevOnlyModule(getId(item)))
}
