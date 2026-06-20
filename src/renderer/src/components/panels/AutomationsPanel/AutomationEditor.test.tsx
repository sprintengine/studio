import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AutomationsProviders } from '../../../../../shared/automations/contracts'
import { AutomationEditor } from './AutomationEditor'

const BLOCKED_REASON =
  'Automation action provider "weather-deck.refresh-forecast" from module "weather-deck" is blocked: Module "weather-deck" is not trusted in Settings -> Modules.'

const providers: AutomationsProviders = {
  triggers: [{
    kind: 'schedule',
    configSchema: { type: 'object' },
    requiredIntegrations: [],
    missingIntegrations: [],
  }],
  actions: [{
    kind: 'weather-deck.refresh-forecast',
    configSchema: { type: 'object' },
    requiredIntegrations: [],
    missingIntegrations: [],
    blockedReason: BLOCKED_REASON,
  }],
}

const markup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'create' }}
    providers={providers}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)

assert.match(markup, /weather-deck\.refresh-forecast \(blocked\)/, 'blocked provider is labelled in the selector')
assert.match(markup, /Automation action provider/, 'blocked reason is rendered as visible editor feedback')
assert.match(markup, /weather-deck\.refresh-forecast/, 'blocked reason names the provider')
assert.match(markup, /not trusted in Settings -&gt; Modules/, 'blocked reason names the trust state')
assert.match(markup, /Create automation<\/button>/, 'create action remains visible')
assert.match(markup, /<button[^>]*disabled=""[^>]*>Create automation/u, 'blocked provider disables submit')

console.log('AutomationEditor blocked-provider render tests passed')
