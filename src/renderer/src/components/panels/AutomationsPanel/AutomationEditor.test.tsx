import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  AutomationDefinition,
  AutomationsProviders,
} from '../../../../../shared/automations/contracts'
import {
  EMPTY_REPO_EVENT_FORM,
  EMPTY_SPRINT_LANDED_FORM,
  EMPTY_WEBHOOK_FORM,
  buildRepoEventConfig,
  buildWebhookConfig,
  repoEventFormFromConfig,
  isAuthorableTrigger,
  resolveSubmitTrigger,
  shouldSendWebhookTrigger,
  triggersEquivalent,
  webhookFormFromConfig,
  webhookTriggerError,
  type SubmitTriggerForm,
} from './automationsFormat'
import { AutomationEditor, resolveAutomationRuntimeCli } from './AutomationEditor'

function triggerForm(overrides: Partial<SubmitTriggerForm>): SubmitTriggerForm {
  return {
    triggerKind: 'schedule',
    cadenceType: 'interval',
    everyMinutes: 30,
    timeLocal: '09:00',
    daysOfWeek: [1, 2, 3, 4, 5],
    atDatetime: '',
    repoEvent: { ...EMPTY_REPO_EVENT_FORM },
    webhook: { ...EMPTY_WEBHOOK_FORM },
    sprintLanded: { ...EMPTY_SPRINT_LANDED_FORM },
    ...overrides,
  }
}

function definition(trigger: AutomationDefinition['trigger']): AutomationDefinition {
  return {
    id: 'auto-1',
    name: 'Existing automation',
    status: 'enabled',
    trigger,
    action: { kind: 'spawn-agent', config: { prompt: 'Review the repo' } },
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

// ---------------------------------------------------------------------------
// Blocked action provider render — disabled option + visible reason + disabled
// submit. The trigger-family picker also renders (create mode).
// ---------------------------------------------------------------------------

const BLOCKED_REASON =
  'Automation action provider "weather-deck.refresh-forecast" from module "weather-deck" is blocked: Module "weather-deck" is not trusted in Settings -> Modules.'

const blockedProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
    { kind: 'webhook', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
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
    providers={blockedProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)

assert.match(markup, /weather-deck\.refresh-forecast — unavailable/, 'blocked provider reads "<label> — unavailable"')
assert.match(markup, /not trusted in Settings -&gt; Modules/, 'blocked reason names the trust state')
assert.match(markup, /<button[^>]*disabled=""[^>]*>Create automation/u, 'blocked provider disables submit')

console.log('AutomationEditor blocked-provider render tests passed')

// ---------------------------------------------------------------------------
// Config-build unit tests (T4 AC#5) — pure repo-event / webhook drafts.
// ---------------------------------------------------------------------------

assert.deepEqual(
  buildRepoEventConfig({ provider: 'github', eventTypes: ['created', 'updated'], externalKey: 'PROJ-1', label: 'My source' }),
  { kind: 'repo-event', provider: 'github', eventTypes: ['created', 'updated'], externalKey: 'PROJ-1', label: 'My source' },
  'repo-event config carries provider, event types, key and label',
)
assert.deepEqual(
  buildRepoEventConfig({ ...EMPTY_REPO_EVENT_FORM }),
  { kind: 'repo-event', provider: 'any' },
  'an empty repo-event omits optional fields and defaults provider to any',
)

assert.deepEqual(
  buildWebhookConfig({ enabled: true, port: '8765', path: 'deploy', secret: 'x'.repeat(20), hasSecret: false, eventType: 'push', label: 'Deploy' }),
  { kind: 'webhook', enabled: true, port: 8765, path: 'deploy', eventType: 'push', label: 'Deploy', secret: 'x'.repeat(20) },
  'webhook config coerces the port to an integer and carries the new secret',
)
assert.deepEqual(
  buildWebhookConfig({ ...EMPTY_WEBHOOK_FORM, enabled: false, path: 'hook' }),
  { kind: 'webhook', enabled: false, path: 'hook' },
  'a webhook with no new secret omits the secret field (the stored one is preserved only when this config is NOT sent — see the omit-trigger path)',
)

console.log('AutomationEditor config-build tests passed')

// ---------------------------------------------------------------------------
// Webhook secret rules (T4 AC#3) — write-only, >=16, regenerate-on-edit.
// ---------------------------------------------------------------------------

assert.equal(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, enabled: true, port: '80', path: 'h', secret: 'short' }, { sendingTrigger: true }),
  'Webhook secret must be at least 16 characters.',
  'a secret shorter than 16 chars blocks save',
)
assert.match(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, enabled: true, port: '80', path: 'h', hasSecret: false }, { sendingTrigger: true }) ?? '',
  /Generate a webhook secret/,
  'enabling a webhook with no stored secret requires generating one',
)
assert.match(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, enabled: true, port: '80', path: 'h', hasSecret: true }, { sendingTrigger: true }) ?? '',
  /Regenerate the webhook secret/,
  'changing an enabled webhook requires regenerating the secret (the stored one is never readable)',
)
assert.match(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, enabled: false, port: '80', path: 'hook', hasSecret: true }, { sendingTrigger: true }) ?? '',
  /Regenerate the webhook secret/,
  'editing a DISABLED webhook that has a stored secret also requires regenerating — sending the rebuilt config would otherwise drop the stored credential (Fallback Discipline)',
)
assert.equal(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, enabled: true, hasSecret: true }, { sendingTrigger: false }),
  null,
  'an unchanged webhook (trigger omitted) needs no secret — the stored one is preserved',
)
assert.match(
  webhookTriggerError({ ...EMPTY_WEBHOOK_FORM, port: '70000' }, { sendingTrigger: true }) ?? '',
  /port must be a whole number/,
  'an out-of-range port blocks save',
)

console.log('AutomationEditor webhook-secret rule tests passed')

// ---------------------------------------------------------------------------
// Round-trip without conversion (T4 AC#4) — load → form → build reproduces the
// trigger for every family; a loaded cron schedule stays verbatim.
// ---------------------------------------------------------------------------

// repo-event: seed the form from the loaded config, rebuild, expect the same.
const repoEventTrigger = {
  kind: 'repo-event',
  config: { kind: 'repo-event', provider: 'github', eventTypes: ['created'], externalKey: 'PROJ-9', label: 'Issues' },
}
const repoForm = triggerForm({ triggerKind: 'repo-event', repoEvent: repoEventFormFromConfig(repoEventTrigger.config) })
const repoResolved = resolveSubmitTrigger({ mode: 'edit', definition: definition(repoEventTrigger) }, repoForm, 'UTC')
assert.deepEqual(repoResolved, repoEventTrigger, 'repo-event round-trips through edit unchanged')

// webhook: the redacted config (hasSecret, no secret) rebuilds without a secret;
// the trigger is equivalent so the patch is omitted and the stored secret kept.
const webhookLoaded = { kind: 'webhook', enabled: true, port: 8765, path: 'deploy', eventType: 'push', label: 'Deploy', hasSecret: true }
const webhookTrigger = { kind: 'webhook', config: webhookLoaded }
const webhookForm = triggerForm({ triggerKind: 'webhook', webhook: webhookFormFromConfig(webhookLoaded) })
const webhookResolved = resolveSubmitTrigger({ mode: 'edit', definition: definition(webhookTrigger) }, webhookForm, 'UTC')
assert.deepEqual(
  webhookResolved.config,
  { kind: 'webhook', enabled: true, port: 8765, path: 'deploy', eventType: 'push', label: 'Deploy' },
  'webhook round-trips its fields (minus the never-readable secret)',
)
assert.equal(triggersEquivalent(webhookResolved, webhookTrigger), true, 'an unchanged webhook is detected as equivalent')
assert.equal(shouldSendWebhookTrigger(webhookForm.webhook, webhookLoaded), false, 'an unchanged webhook omits its trigger patch (preserves the secret)')
assert.equal(
  shouldSendWebhookTrigger({ ...webhookForm.webhook, secret: 'y'.repeat(20) }, webhookLoaded),
  true,
  'a regenerated secret forces the trigger patch to be sent',
)

// cron schedule: read-only, returned verbatim (engine rejects cron authoring).
const cronTrigger = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'cron', expression: '0 9 * * 1' } },
}
const cronResolved = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(cronTrigger) },
  triggerForm({ triggerKind: 'schedule', cadenceType: 'weekly', everyMinutes: 30, timeLocal: '08:30', daysOfWeek: [1, 3] }),
  'America/New_York',
)
assert.deepEqual(cronResolved, cronTrigger, 'a loaded cron schedule round-trips verbatim, never converted to interval')

// editable schedule still builds from the cadence form and keeps the timezone.
const intervalTrigger = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'Europe/London', cadence: { type: 'interval', everyMinutes: 15 } },
}
const editedSchedule = resolveSubmitTrigger(
  { mode: 'edit', definition: definition(intervalTrigger) },
  triggerForm({ triggerKind: 'schedule', cadenceType: 'weekly', everyMinutes: 30, timeLocal: '08:30', daysOfWeek: [1, 3] }),
  'UTC',
)
assert.deepEqual(
  editedSchedule.config,
  { kind: 'schedule', timezone: 'Europe/London', cadence: { type: 'weekly', timeLocal: '08:30', daysOfWeek: [1, 3] } },
  'an editable schedule builds from the cadence form and keeps the loaded timezone',
)

// The one-shot `at` cadence builds from its datetime-local field, and a loaded
// `at` schedule stays editable (unlike cron) — it round-trips through the form.
const atResolved = resolveSubmitTrigger(
  { mode: 'create' },
  triggerForm({ triggerKind: 'schedule', cadenceType: 'at', atDatetime: '2026-07-09T09:30' }),
  'Europe/Dublin',
)
assert.deepEqual(
  atResolved.config,
  { kind: 'schedule', timezone: 'Europe/Dublin', cadence: { type: 'at', datetime: '2026-07-09T09:30' } },
  'a one-time schedule builds from the datetime-local field',
)
const atTrigger = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'at', datetime: '2026-07-09T09:30' } },
}
assert.equal(isAuthorableTrigger(atTrigger), true, 'a loaded at schedule remains editable')

console.log('AutomationEditor trigger round-trip tests passed')

// ---------------------------------------------------------------------------
// Family render (T4 AC#1/#2/#3) — picker offers all families; an unavailable
// family is disabled with its reason; cron stays read-only.
// ---------------------------------------------------------------------------

const switchboardProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
    { kind: 'repo-event', configSchema: { type: 'object' }, requiredIntegrations: ['module:switchboard'], missingIntegrations: [] },
    { kind: 'webhook', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
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
    providers={switchboardProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(repoEventMarkup, /Event types/, 'repo-event renders its authoring fields')
assert.doesNotMatch(repoEventMarkup, /Editing this trigger type isn.t supported yet/, 'repo-event is now editable, not read-only')

// repo-event with Switchboard absent from providers.triggers — shown, not hidden.
const noSwitchboardProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
    { kind: 'webhook', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
  actions: switchboardProviders.actions,
}
const unavailableRepoMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(repoEventTrigger) }}
    providers={noSwitchboardProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(unavailableRepoMarkup, /needs the Switchboard module/, 'an unavailable repo-event family shows its reason inline')

const webhookMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(webhookTrigger) }}
    providers={switchboardProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(webhookMarkup, /\/automations\/webhooks\/deploy/, 'webhook shows the delivery URL with the configured path')
assert.match(webhookMarkup, /Regenerate secret/, 'a stored webhook secret offers regenerate, never the value')
assert.match(webhookMarkup, /x-multicode-signature/, 'webhook shows the HMAC signature header as helper text')

const cronMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: definition(cronTrigger) }}
    providers={switchboardProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(cronMarkup, /Cron · 0 9 \* \* 1/, 'cron schedule renders a read-only summary of its expression')
assert.match(cronMarkup, /Editing this trigger type isn.t supported yet/, 'cron schedule stays read-only (no authoring control)')
assert.doesNotMatch(cronMarkup, /Run every \(minutes\)/, 'cron schedule hides the editable cadence fields')

console.log('AutomationEditor family render tests passed')

// ---------------------------------------------------------------------------
// Agent block — the reused spawn picker (select mode) replaces the old flat
// Specialist / CLI / Model selects. A spawn-agent action whose schema carries a
// `cli` field renders the embedded picker trigger (default General agent), the
// CliModelPickerButton runtime row, and the permission summary; it must NOT
// render the retired flat Specialist/Model select help text.
// ---------------------------------------------------------------------------

const spawnAgentProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
    { kind: 'webhook', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
  actions: [{
    kind: 'spawn-agent',
    configSchema: {
      type: 'object',
      properties: { cli: { type: 'string' }, prompt: { type: 'string' } },
      required: ['prompt'],
    },
    requiredIntegrations: [],
    missingIntegrations: [],
  }],
}

const agentBlockMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'create' }}
    providers={spawnAgentProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)

assert.match(agentBlockMarkup, /General agent/, 'the agent block defaults to General agent (no specialist) in the picker trigger')
// The trigger carries the identity; what a general agent IS is the aside's own
// "Agent — Plain — no role, no soul" fact rather than a second line saying it
// again beside the control (MC-2035 trim).
assert.match(agentBlockMarkup, /Plain — no role, no soul/, 'the aside states the agent as a fact of the run')
assert.match(agentBlockMarkup, /Agent runtime and model/, 'the model control reuses CliModelPickerButton')
assert.doesNotMatch(
  agentBlockMarkup,
  /Same team, runtimes, and permission presets/,
  'the help text explaining where the picker came from is gone',
)
// Permission is its own field, and its option text IS the state: an automation
// with no stored preset runs unattended, so the control must read that rather
// than "Default" — the editor may not show a preset the run will not use.
assert.match(agentBlockMarkup, /Permission/, 'the editor labels the permission field')
assert.match(
  agentBlockMarkup,
  /Bypass all — runs unattended/,
  'an unset automation reads as the unattended default',
)
assert.doesNotMatch(
  agentBlockMarkup,
  /Default — asks before acting<\/span>\s*<svg/,
  'the trigger does not read "Default" for an automation that will run on bypass',
)
assert.doesNotMatch(agentBlockMarkup, /Run as a specialist agent, or a general agent\./, 'the retired flat Specialist select is gone')
assert.doesNotMatch(agentBlockMarkup, /Model passed at launch/, 'the retired flat Model select is gone')

console.log('AutomationEditor agent-block render tests passed')

// ---------------------------------------------------------------------------
// Connector picker (T8) — a spawn-agent action whose schema exposes connectorId
// renders a "Connector" control defaulting to "No connector"; a schema without
// connectorId does not. A stored connectorId round-trips into the control.
// renderToStaticMarkup runs no effects, so the catalog stays loading and the
// picker shows the selected value's label (the default or the stored id).
// ---------------------------------------------------------------------------

const connectorProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
    { kind: 'webhook', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
  actions: [{
    kind: 'spawn-agent',
    configSchema: {
      type: 'object',
      properties: { cli: { type: 'string' }, prompt: { type: 'string' }, connectorId: { type: 'string' } },
      required: ['prompt'],
    },
    requiredIntegrations: [],
    missingIntegrations: [],
  }],
}

const connectorCreateMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'create' }}
    providers={connectorProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(connectorCreateMarkup, /Connector/, 'a connectorId-bearing action renders the connector control')
assert.match(connectorCreateMarkup, /No connector/, 'the connector picker defaults to "No connector"')

// A connectorId is not rendered as a generic free-text config input — the picker owns it.
assert.doesNotMatch(connectorCreateMarkup, /automation-config-connectorId/, 'connectorId is not a free-text config field')

// An action schema without connectorId renders no connector control.
assert.doesNotMatch(agentBlockMarkup, />Connector</, 'no connector control when the schema lacks connectorId')

// Edit: a stored connectorId round-trips into the control (shown as its id while
// the catalog is still loading under static render).
const connectorEditDef: AutomationDefinition = {
  ...definition({ kind: 'schedule', config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 30 } } }),
  action: { kind: 'spawn-agent', config: { prompt: 'Deploy the service', connectorId: 'railway' } },
}
const connectorEditMarkup = renderToStaticMarkup(
  <AutomationEditor
    editor={{ mode: 'edit', definition: connectorEditDef }}
    providers={connectorProviders}
    workspaceRoot="/tmp/multicode-automation-editor"
    onCancel={() => {}}
    onSaved={() => {}}
  />,
)
assert.match(connectorEditMarkup, /railway/, 'a stored connectorId round-trips into the connector control')

console.log('AutomationEditor connector-picker render tests passed')

// ---------------------------------------------------------------------------
// A starter, opened where it is tailored (MC-2035). The Extensions shelf
// configures nothing: a Get lands here, so this is the one screen that has to
// show a real agent, a real cadence, `bypass_all` and the starter's prompt with
// no empty picker anywhere — and has to say where the automation came from, so a
// starter is distinguishable from something written in this project.
// ---------------------------------------------------------------------------

const starterProviders: AutomationsProviders = {
  triggers: [
    { kind: 'schedule', configSchema: { type: 'object' }, requiredIntegrations: [], missingIntegrations: [] },
  ],
  actions: [{
    kind: 'spawn-agent',
    configSchema: {
      type: 'object',
      properties: { cli: { type: 'string' }, prompt: { type: 'string' }, spawnSkillId: { type: 'string' }, connectorId: { type: 'string' } },
      required: ['prompt'],
    },
    requiredIntegrations: [],
    missingIntegrations: [],
  }],
}

const DAILY_AT_0200: AutomationDefinition['trigger'] = {
  kind: 'schedule',
  config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'daily', timeLocal: '02:00' } },
}

// Exactly what the install writes (src/main/automations/definition-write.ts
// `installFromCatalogue`): status enabled, the provenance pair stamped by the
// host, and an action config that names NO cli — the launch resolves that.
const starterDefinition: AutomationDefinition = {
  ...definition(DAILY_AT_0200),
  name: 'Dead code sweep',
  action: { kind: 'spawn-agent', config: { prompt: 'Find code in this repository that nothing reaches.' } },
  runInWorktree: true,
  sourceCatalogueId: 'multicode.dead-code-sweep',
  sourcePublisher: 'Multicode Labs',
}

function renderEditor(def: AutomationDefinition): string {
  return renderToStaticMarkup(
    <AutomationEditor
      editor={{ mode: 'edit', definition: def }}
      providers={starterProviders}
      workspaceRoot="/tmp/multicode-automation-editor"
      onCancel={() => {}}
      onSaved={() => {}}
    />,
  )
}

const starterMarkup = renderEditor(starterDefinition)

assert.match(starterMarkup, /Dead code sweep/, 'the head carries the automation name, edited in place')
assert.match(starterMarkup, /Multicode Labs/, 'the head names the publisher beneath it')
assert.match(starterMarkup, /Extensions shelf/, 'the aside names where it came from')
assert.match(starterMarkup, /Find code in this repository that nothing reaches\./, 'the starter’s prompt is loaded')
assert.match(starterMarkup, /Daily/, 'the cadence is the real one the definition carries')
assert.match(starterMarkup, /02:00/, 'including its time')
assert.match(starterMarkup, /Bypass all — runs unattended/, 'permission reads the unattended default it will run on')
assert.match(starterMarkup, /Every run/, 'the aside states the run contract')
assert.match(starterMarkup, /A branch it can open a pull request from/, 'what a worktree run produces')

// No autonomy control anywhere. `review_only` is retired (MC-2036): it injected
// "do not create files, commit, push" into the prompt, which made opening a pull
// request impossible. Reviewer-vs-fixer intent lives in the prompt text now.
for (const gone of [/autonomy/i, /review.only/i, /Write-up only/i]) {
  assert.doesNotMatch(starterMarkup, gone, `no autonomy control survives (${gone})`)
}

// An automation written here says so, and has no publisher line to show.
const handWrittenMarkup = renderEditor({
  ...definition(DAILY_AT_0200),
  name: 'My own nightly job',
  action: { kind: 'spawn-agent', config: { prompt: 'Groom the backlog.' } },
})
assert.match(handWrittenMarkup, /Written in this project/, 'a hand-written automation names no shelf')
assert.doesNotMatch(handWrittenMarkup, /Extensions shelf/, 'and is not dressed up as a starter')
assert.doesNotMatch(handWrittenMarkup, /Multicode Labs/, 'with no publisher line')

// The runtime the picker shows is the one the RUN resolves, in the launch's own
// order: the definition's cli, else the last-selected one, else the catalog. A
// picker that showed the catalog's first entry would name a runtime the 02:00 run
// is not going to use. (Asserted on the pure resolver rather than on the rendered
// picker: under `renderToStaticMarkup` a zustand read returns the store's INITIAL
// state, so a static render cannot witness a store value at all.)
const CATALOG = [{ value: 'claude-code' }, { value: 'cursor' }]
assert.equal(resolveAutomationRuntimeCli('codex', 'cursor', CATALOG), 'codex', 'the definition’s own cli wins')
assert.equal(resolveAutomationRuntimeCli(undefined, 'cursor', CATALOG), 'cursor', 'an unset cli reads the launch’s fallback')
assert.equal(resolveAutomationRuntimeCli('  ', 'cursor', CATALOG), 'cursor', 'and blank counts as unset')
assert.equal(resolveAutomationRuntimeCli(undefined, undefined, CATALOG), 'claude-code', 'with no fallback set, the catalog answers')
assert.equal(resolveAutomationRuntimeCli(undefined, undefined, []), 'claude-code', 'and the picker is never left empty')

console.log('AutomationEditor starter render tests passed')
