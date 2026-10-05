import { SETTINGS_ENVELOPE_FIELDS, adoptStoredSettings, useWorkspaceStore } from '../../store/workspaceStore'
import { APP_SETTINGS_STORAGE_KEY } from '../../store/slices/persistenceSlice'
import { pickLaunchSettings } from '../../store/launchSettingsReadModel'

// Writing an app setting from an AUXILIARY window, safely.
//
// The settings envelope is persisted whole: one store mutation writes every
// field `extractSettingsFields` names. An aux window hydrated its copy when it
// opened and hears of the workspace window's later changes only as they are
// saved (`followStoredSettings`), so a setter called here could push a stale
// copy over the sidebar width, the chat list view and everything else the
// person has changed since. That is
// why the diff window's "Show in the app" deliberately writes nothing (T3) and
// why every other setter in the product lives in the workspace window.
//
// The diff window's side-by-side / unified toggle (T4) has no such home: the
// control is IN the window, and the setting is app-wide by the item's own
// ruling. So the write happens here, and the hazard is removed rather than
// accepted: the persisted settings envelope is re-read first and merged back
// into this window's store, so the write that follows carries the workspace
// window's latest values plus the one field this window actually changed.
//
// Other aux windows hear of the write (`followStoredSettings` below); what it
// still cannot do is tell a workspace window that is already open. It
// will read the new value on its next hydrate; until then the pane's Diff tab
// keeps the view it was showing. Two views of two different surfaces disagreeing
// until a restart is a smaller wrong than one window silently reverting
// another's settings, which is the trade this helper exists to make.
export function writeAuxWindowSetting(mutate: () => void): void {
  const settings = readStoredSettings()
  if (settings) useWorkspaceStore.setState(settings)
  // An unreadable or malformed settings key is one we do not merge. The write
  // below still lands; it simply carries this window's own snapshot, which is
  // exactly where we would have been without the merge.
  mutate()
}

type StoredSettings = Partial<ReturnType<typeof useWorkspaceStore.getState>>

/**
 * The settings envelope as last saved, as a patch for this window's store, or
 * null when the key is missing, unreadable or carries nothing.
 */
function readStoredSettings(): StoredSettings | null {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
    const envelope = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> } | null) : null
    const state = envelope?.state
    // The ALLOWLIST, not the whole object. "The key holds settings fields and
    // nothing else" is an assumption about a file on disk — one this process
    // did not necessarily write, and cannot check — and `setState` with a cast
    // to `never` would have let anything in that file reach the store,
    // workspaces and all. Only the fields the envelope is defined to carry are
    // merged, and only the ones actually present.
    if (!state || typeof state !== 'object') return null
    const settings: Record<string, unknown> = {}
    for (const key of SETTINGS_ENVELOPE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(state, key)) settings[key] = state[key]
    }
    // The envelope no longer carries the agent-launch fields (main owns
    // them), so this window's read model of those is kept rather than
    // replaced by whatever the file does or does not hold.
    if (settings.appSettings && typeof settings.appSettings === 'object') {
      settings.appSettings = {
        ...settings.appSettings,
        ...pickLaunchSettings(useWorkspaceStore.getState().appSettings),
      }
    }
    return Object.keys(settings).length > 0 ? (settings as StoredSettings) : null
  } catch {
    return null
  }
}

/**
 * Keep an auxiliary window's settings current: whenever a workspace window
 * saves its settings, adopt them here — the theme, the window material, the
 * chat's appearance and the rest — without writing them back
 * (`adoptStoredSettings`). localStorage is shared by every window in the app
 * partition, and the browser tells every OTHER window of a write to it, which
 * is exactly the set of windows whose copy just went stale. Returns the
 * unsubscriber.
 */
export function followStoredSettings(): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== APP_SETTINGS_STORAGE_KEY) return
    const settings = readStoredSettings()
    if (settings) adoptStoredSettings(settings)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
