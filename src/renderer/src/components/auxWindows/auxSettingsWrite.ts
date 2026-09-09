import { useWorkspaceStore } from '../../store/workspaceStore'
import { APP_SETTINGS_STORAGE_KEY } from '../../store/slices/persistenceSlice'

// Writing an app setting from an AUXILIARY window, safely.
//
// The settings envelope is persisted whole: one store mutation writes every
// field `extractSettingsFields` names. An aux window hydrated its copy when it
// opened and never hears about the workspace window's later changes, so a
// setter called here would push that opening snapshot over the sidebar width,
// the chat list view and everything else the person has changed since. That is
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
// What it still cannot do is tell a workspace window that is already open. It
// will read the new value on its next hydrate; until then the pane's Diff tab
// keeps the view it was showing. Two views of two different surfaces disagreeing
// until a restart is a smaller wrong than one window silently reverting
// another's settings, which is the trade this helper exists to make.
export function writeAuxWindowSetting(mutate: () => void): void {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
    const envelope = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> } | null) : null
    const state = envelope?.state
    // The key holds settings fields and nothing else (the registry is a
    // separate, frozen key), so merging it wholesale cannot reach a workspace.
    if (state && typeof state === 'object') {
      useWorkspaceStore.setState(state as never)
    }
  } catch {
    // An unreadable or malformed settings key is one we do not merge. The write
    // below still lands; it simply carries this window's own snapshot, which is
    // exactly where we would have been without this helper.
  }
  mutate()
}
