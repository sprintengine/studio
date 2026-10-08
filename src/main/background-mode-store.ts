/**
 * Main-owned mirror of the "keep running in the background" setting.
 *
 * Same push contract as the window-material mirror: the renderer owns the
 * preference (`appSettings.keepRunningInBackground`) and pushes it on change;
 * main persists it under userData and reads it **synchronously** — the read
 * happens inside the `window-all-closed` handler, which is exactly the moment
 * there is no renderer left to ask.
 *
 * Absent, unreadable, or malformed all read as OFF. That is not a convenience
 * default: off is byte-for-byte today's behavior, so a store we cannot trust
 * costs the user nothing, while a store that guessed ON would leave a process
 * alive that nobody asked to keep.
 *
 * Deliberately carries no revision counter, unlike the launch-settings record:
 * main never writes this value and never broadcasts it back, so there is no
 * echo to order. The renderer is the only writer.
 */
import { createBooleanFileSetting, type BooleanFileSetting, type BooleanFileSettingDeps } from './boolean-file-setting'

export type BackgroundModeStore = BooleanFileSetting

/** `isEnabled()` is what the last-window-close decision reads; `set` adopts a renderer push. */
export function createBackgroundModeStore(deps: BooleanFileSettingDeps): BackgroundModeStore {
  return createBooleanFileSetting(
    {
      fileName: 'background-mode.json',
      key: 'keepRunningInBackground',
      fallback: false,
      notPersisted: {
        title: 'Background mode setting not persisted',
        message:
          'The background-mode setting could not be written to disk; it applies for this session but will not survive a restart.',
      },
    },
    deps,
  )
}
