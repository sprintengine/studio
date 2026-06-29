import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AutomationsHostBanner } from './AutomationsHostBanner'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// AutomationsHostBanner is a pure, hookless function component, so invoking it
// directly returns its element tree (a labelled region wrapping the identity
// text and the return GhostButton). That exercises the affordance's structure,
// aria, and click behaviour without a DOM or the workspace store.
function bannerElement(returnLabel: string, onReturn: () => void): ReactElement {
  return AutomationsHostBanner({ onReturn, returnLabel }) as ReactElement
}
function childrenOf(el: ReactElement): ReactElement[] {
  return el.props.children as ReactElement[]
}
function returnButtonOf(el: ReactElement): ReactElement {
  // Last child is the GhostButton; the first is the identity span.
  const kids = childrenOf(el)
  return kids[kids.length - 1]
}

run('is a labelled region identifying the workspace as the Automations host', () => {
  const el = bannerElement('Back to workspace', () => {})
  assert.equal(el.props.role, 'region', 'a landmark region, not anonymous chrome')
  assert.equal(
    el.props['aria-label'],
    'Automations host workspace',
    'the region names the host so screen readers announce the ownership boundary',
  )
})

run('carries a keyboard-operable return button labelled by text, not color alone', () => {
  let returned = false
  const button = returnButtonOf(bannerElement('Back to workspace', () => { returned = true }))
  assert.equal(button.props.children, 'Back to workspace', 'the action carries a literal text label')
  assert.equal(button.props.disabled, undefined, 'the return is always operable')
  assert.equal(button.props.tabIndex, undefined, 'no negative tabIndex — it stays in the tab order')
  button.props.onClick()
  assert.equal(returned, true, 'clicking the return invokes onReturn')
})

run('renders on the real server surface with the host identity, descriptor, and return', () => {
  const markup = renderToStaticMarkup(
    <AutomationsHostBanner onReturn={() => {}} returnLabel="Back to workspace" />,
  )
  assert.match(markup, /role="region"/, 'the landmark survives to real HTML')
  assert.match(markup, /aria-label="Automations host workspace"/, 'the region keeps its accessible name')
  assert.match(markup, /Automations host/, 'the identity title is present')
  assert.match(markup, /not a project workspace/, 'copy distinguishes the host from a normal workspace')
  assert.match(markup, /<button[^>]*>Back to workspace<\/button>/, 'the return renders a native, focusable button')
  // GhostButton wires the shared visible focus ring — keyboard focus is not suppressed.
  assert.match(markup, /focus-visible:ring/, 'the return exposes a visible focus state')
})

run('the return label names the destination for each return mode', () => {
  const toWorkspace = renderToStaticMarkup(
    <AutomationsHostBanner onReturn={() => {}} returnLabel="Back to workspace" />,
  )
  assert.match(toWorkspace, />Back to workspace</, 'with a rail workspace, the action returns to it')
  const toSetup = renderToStaticMarkup(
    <AutomationsHostBanner onReturn={() => {}} returnLabel="New workspace" />,
  )
  assert.match(toSetup, />New workspace</, 'with no rail workspace, the action opens new-workspace setup')
})

// Source-contract checks for the wiring the unit render cannot reach: the banner
// only mounts while the host's own content is on screen, and its return resolves
// to the first rail workspace or new-workspace setup. Mirrors the source-contract
// style of SpawnDebugToggle.test.tsx / BacklogRow.test.tsx.
const managerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
  'utf8',
)
const automationsScreenSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/automations/AutomationsScreen.tsx'),
  'utf8',
)

run('WorkspaceManager mounts the banner only while the active host content is shown', () => {
  assert.match(
    managerSource,
    /automationsHostActive = Boolean\(activeWorkspace && isAutomationsHostWorkspace\(activeWorkspace\)\)/,
    'host-active is derived from the active workspace mode',
  )
  assert.match(
    managerSource,
    /automationsHostActive && !showNewWorkspacePanel && !automationsOpen \? \(\s*<AutomationsHostBanner/,
    'the banner is gated off when the new-workspace panel or Automations overlay owns the area',
  )
})

run('the return resolves to the first rail workspace, else new-workspace setup', () => {
  assert.match(
    managerSource,
    /automationsHostReturnTarget = railWorkspaces\[0\] \?\? null/,
    'the return target is the first rail (non-host) workspace',
  )
  assert.match(
    managerSource,
    /setActiveWorkspaceForWindow\(workspaceWindowId, automationsHostReturnTarget\.id\)/,
    'returning activates the rail workspace',
  )
  assert.match(
    managerSource,
    /\} else \{\s*openNewWorkspacePanel\(\)/,
    'with no rail workspace the return opens new-workspace setup',
  )
})

run('the Automations "Open agent" action reveals the agent before dismissing the screen', () => {
  assert.ok(
    (automationsScreenSource.match(/revealAutomationAgent\(\{ workspaceId: wsId, agentId \}\)/g) ?? []).length >= 2,
    'both the runs feed and the detail pane reveal the launched agent into its (host) workspace',
  )
})

if (failures > 0) {
  console.error(`AutomationsHostBanner.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('AutomationsHostBanner.test.tsx: ok')
