import type { RegisterRenderer } from '@sprintengine/module-sdk'

// The renderer entry: Studio calls this once, when the module loads, with a
// host scoped to this module. Everything the extension adds to the app's UI is
// registered here; there is nothing to render until something is registered.
//
// This starting point contributes one command ("{{displayName}}: Say hello" in
// the command palette). Replace it with what IDEA.md describes — the skill's
// SKILL.md has a table of which API fits which idea.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerCommand({
    // Registered as "{{id}}.say-hello": the host namespaces it by module id.
    id: 'say-hello',
    title: '{{displayName}}: Say hello',
    category: '{{displayName}}',
    scopes: ['global'],
    run() {
      window.alert(`{{displayName}} is running on host API ${host.hostApiVersion}.`)
    },
  })
}
