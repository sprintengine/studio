import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  AutomationDefinition,
  AutomationsProviders,
} from '../../../../../shared/automations/contracts'
import { resolveSubmitTrigger, type ScheduleCadenceForm } from './automationsFormat'
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

assert.match(markup, /weather-deck\.refresh-forecast — unavailable/, 'blocked provider reads "<label> — unavailable" (unknown kind falls back to the raw kind)')
assert.match(markup, /Automation action provider/, 'blocked reason is rendered as visible editor feedback')
assert.match(markup, /weather-deck\.refresh-forecast/, 'blocked reason names the provider')
assert.match(markup, /not trusted in Settings -&gt; Modules/, 'blocked reason names the trust state')
assert.match(markup, /Create automation<\/button>/, 'create action remains visible')
assert.match(markup, /<button[^>]*disabled=""[^>]*>Create automation/u, 'blocked provider disables submit')

console.log('AutomationEditor blocked-provider render tests passed')

// ---------------------------------------------------------------------------
// Trigger round-trip (T1 data-loss fix). The schedule cadence editor must not
// rewrite a trigger family it cannot author. A "sacrificial" cadence form proves
// those families ignore the form and persist their loaded trigger verbatim.
// ---------------------------------------------------------------------------

const SACRIFICIAL_FORM: ScheduleCadenceForm = {
  cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5],
}

function definition(trigger: AutomationDefinition['trigger']): AutomationDefinition {
  return {
    id: 'auto-1',
    name: 'Existing automation',
    status: 'enabled',
    trigger,
    action: { kind: 'spawn-agent', config: { prompt: 'Review the repo' } },
    autonomyDefault: 'review_only',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

const repoEventTrigger = { kind: 'repo-event', config: { kind: 'repo-event', events: ['push'] } }
const repoResolved = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(repoEventTrigger) }, SACRIFICIAL_FORM, 'UTC',
)
assert.deepEqual(repoResolved, repoEventTrigger, 'repo-event trigger round-trips through edit unchanged')

const webhookTrigger = { kind: 'webhook', config: { kind: 'webhook', secretRef: 'wh-1' } }
const webhookResolved = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(webhookTrigger) }, SACRIFICIAL_FORM, 'UTC',
)
assert.deepEqual(webhookResolved, webhookTrigger, 'webhook trigger round-trips through edit unchanged')

const cronTrigger = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'cron', expression: '0 9 * * 1' } },
}
const cronResolved = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(cronTrigger) }, SACRIFICIAL_FORM, 'America/New_York',
)
assert.deepEqual(cronResolved, cronTrigger, 'cron schedule round-trips unchanged (no conversion to interval)')
assert.equal(
  (cronResolved.config as { cadence: { expression: string } }).cadence.expression,
  '0 9 * * 1',
  'cron expression is preserved through save',
)

// Editable schedule families still build from the cadence form, preserving the
// loaded timezone rather than forcing the local one.
const intervalTrigger = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'Europe/London', cadence: { type: 'interval', everyMinutes: 15 } },
}
const editedSchedule = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(intervalTrigger) },
  { cadenceType: 'weekly', everyMinutes: 30, timeLocal: '08:30', daysOfWeek: [1, 3] },
  'UTC',
)
assert.deepEqual(
  editedSchedule.config,
  { kind: 'schedule', timezone: 'Europe/London', cadence: { type: 'weekly', timeLocal: '08:30', daysOfWeek: [1, 3] } },
  'editable schedule builds from the cadence form and keeps the loaded timezone',
)

// Create mode builds a schedule trigger from the fallback timezone.
const createdSchedule = resolveSubmitTrigger(
  { mode: 'create' },
  { cadenceType: 'interval', everyMinutes: 45, timeLocal: '09:00', daysOfWeek: [] },
  'Europe/London',
)
assert.deepEqual(
  createdSchedule.config,
  { kind: 'schedule', timezone: 'Europe/London', cadence: { type: 'interval', everyMinutes: 45 } },
  'create builds a schedule trigger from the cadence form and fallback timezone',
)

console.log('AutomationEditor trigger round-trip tests passed')

// ---------------------------------------------------------------------------
// Read-only render: a family with no editor shows a summary + note instead of
// editable cadence fields; an editable schedule still renders the cadence form.
// ---------------------------------------------------------------------------

const editProviders: AutomationsProviders = {
  triggers: [],
  actions: [{
    kind: 'spawn-agent',
    configSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
    requiredIntegrations: [],
    missingIntegrations: [],
  }],
}

const repoEventMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(repoEventTrigger) }}
    providers={editProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(repoEventMarkup, /Editing this trigger type isn.t supported yet/, 'read-only trigger shows the not-yet-supported note')
assert.doesNotMatch(repoEventMarkup, /Run every \(minutes\)/, 'read-only trigger hides the editable cadence fields')

const cronMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(cronTrigger) }}
    providers={editProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(cronMarkup, /Cron · 0 9 \* \* 1/, 'cron schedule renders a read-only summary of its expression')
assert.doesNotMatch(cronMarkup, /Run every \(minutes\)/, 'cron schedule hides the editable cadence fields')

const scheduleMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(intervalTrigger) }}
    providers={editProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(scheduleMarkup, /Run every \(minutes\)/, 'editable schedule still renders the cadence editor')
assert.doesNotMatch(scheduleMarkup, /Editing this trigger type isn.t supported yet/, 'editable schedule omits the read-only note')

console.log('AutomationEditor read-only trigger render tests passed')
