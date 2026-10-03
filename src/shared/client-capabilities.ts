// What the shell a renderer runs in can do (phase 9 spec, 3.4). A control a
// shell cannot back is hidden or swapped by asking `clientSupports`, never by
// testing whether a `window.api` member exists: in a browser every member
// exists, and the ones a browser cannot do refuse.
//
// Server capabilities are a different question, answered by the Studio's
// welcome. A control that needs both asks both.

export const CLIENT_CAPABILITIES = [
  /** The OS's own file and folder pickers. */
  'native-dialogs',
  /** Show a file in Finder or Explorer on the machine the person is at. */
  'reveal-in-folder',
  /** Open a folder in another app (an editor, a terminal app). */
  'open-in-app',
  /** The OS clipboard without a browser's permission rules. */
  'os-clipboard',
  /** OS notifications, a dock badge, a taskbar flash. */
  'os-notifications',
  /** Windows of their own for a diff or a file. */
  'aux-windows',
  /** More than one workspace window. */
  'multi-window',
  /** A native window the app dresses: caption buttons, traffic lights, window material. */
  'window-controls',
  /** Terminals on the machine the person is at. */
  'terminals',
  /** The desktop's native browser pane, which agents can drive. */
  'browser-pane',
  /** The web client's preview pane, over a server's `previews`. */
  'previews',
  /** A native app menu. */
  'app-menu',
  /** `sprintengine://` links. */
  'deep-links',
  /** A dropped file's path on disk. */
  'drag-paths',
] as const

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number]

/** What the desktop app's own windows can do: everything but the web client's preview pane. */
export const DESKTOP_CLIENT_CAPABILITIES: readonly ClientCapability[] = CLIENT_CAPABILITIES.filter(
  (capability) => capability !== 'previews',
)
