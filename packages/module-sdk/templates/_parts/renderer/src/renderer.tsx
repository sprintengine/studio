import type { RegisterRenderer } from '@sprintengine/module-sdk'

// The renderer entry: Studio calls this once, when the module loads, with a
// host scoped to this module. Everything the extension adds to the app's UI is
// registered here; each part adds its call below.
export const registerRenderer: RegisterRenderer = () => {
}
