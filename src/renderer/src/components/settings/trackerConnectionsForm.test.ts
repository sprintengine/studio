import assert from 'node:assert/strict'

import type { RedactedTrackerConnection, TrackerError, TrackerProviderId } from '../../../../shared/electron-api'
import { presentError, type FailureClass } from '../ui/errorPresentation'
import {
  activeAuthModeSpec,
  canTestDraft,
  connectionCredentialKind,
  connectionHostLabel,
  connectionIsSelfHosted,
  connectionStatusView,
  defaultDraftForProvider,
  draftBlockedReason,
  draftTestKey,
  draftToAddConnectionInput,
  presentTrackerError,
  providerHasAuthModeChoice,
  trackerProviderFormSpec,
  TRACKER_PROVIDER_FORM_SPECS,
} from './trackerConnectionsForm'

function connection(overrides: Partial<RedactedTrackerConnection> = {}): RedactedTrackerConnection {
  return {
    id: 'trk-1',
    provider: 'github',
    baseUrl: null,
    authMode: 'github_pat',
    label: 'GitHub',
    status: 'connected',
    ...overrides,
  }
}

const tests: Array<[string, () => void]> = []
function test(name: string, fn: () => void) {
  tests.push([name, fn])
}

// --- Provider form specs: field visibility is data-driven, not a provider if ---

test('every provider id has exactly one spec', () => {
  const ids: TrackerProviderId[] = ['github', 'jira', 'linear']
  for (const id of ids) {
    assert.equal(trackerProviderFormSpec(id).id, id)
  }
  assert.equal(TRACKER_PROVIDER_FORM_SPECS.length, 3)
})

test('selfHostable drives the server field: GitHub and Jira carry one, Linear does not', () => {
  assert.equal(trackerProviderFormSpec('github').selfHostable, true)
  assert.ok(trackerProviderFormSpec('github').server)
  assert.equal(trackerProviderFormSpec('jira').selfHostable, true)
  assert.ok(trackerProviderFormSpec('jira').server)
  assert.equal(trackerProviderFormSpec('linear').selfHostable, false)
  assert.equal(trackerProviderFormSpec('linear').server, null)
  assert.ok(trackerProviderFormSpec('linear').cloudOnlyNote)
})

test('only Jira offers a Cloud-vs-Data-Center chooser (>1 auth mode)', () => {
  assert.equal(providerHasAuthModeChoice('github'), false)
  assert.equal(providerHasAuthModeChoice('jira'), true)
  assert.equal(providerHasAuthModeChoice('linear'), false)
})

test('token label follows the selected auth mode', () => {
  const cloud = defaultDraftForProvider('jira')
  assert.equal(activeAuthModeSpec(cloud).tokenLabel, 'Email and API token')
  const dc = { ...cloud, authMode: 'jira_pat' as const }
  assert.equal(activeAuthModeSpec(dc).tokenLabel, 'Personal access token')
  assert.equal(activeAuthModeSpec(defaultDraftForProvider('github')).tokenLabel, 'Personal access token')
  assert.equal(activeAuthModeSpec(defaultDraftForProvider('linear')).tokenLabel, 'API key')
})

test('GitHub default draft prefills github.com; Jira has no host default; Linear has no host field', () => {
  assert.equal(defaultDraftForProvider('github').baseUrl, 'github.com')
  assert.equal(defaultDraftForProvider('jira').baseUrl, '')
  assert.equal(defaultDraftForProvider('linear').baseUrl, '')
})

// --- Draft → IPC input normalization ---

test('Linear draft always submits a null baseUrl even if a host was typed', () => {
  const draft = { ...defaultDraftForProvider('linear'), baseUrl: 'nope.example', label: 'L', secret: 'k' }
  assert.equal(draftToAddConnectionInput(draft).baseUrl, null)
})

test('GitHub default host submits null (no override); a GHES host submits its host', () => {
  const gh = { ...defaultDraftForProvider('github'), label: 'GH', secret: 't' }
  // The prefilled github.com default means "use the provider default", not a
  // self-hosted override — submitting the bare host is what broke the client.
  assert.equal(draftToAddConnectionInput(gh).baseUrl, null)
  const ghes = { ...gh, baseUrl: 'ghe.acme.net' }
  assert.equal(draftToAddConnectionInput(ghes).baseUrl, 'ghe.acme.net')
})

test('secret is passed through verbatim (Jira Cloud email:token stays intact)', () => {
  const draft = { ...defaultDraftForProvider('jira'), baseUrl: 'https://acme.atlassian.net', label: 'J', secret: 'me@acme.com:abc' }
  assert.equal(draftToAddConnectionInput(draft).secret, 'me@acme.com:abc')
})

// --- Test gating ---

test('a draft is not testable until name, server (if self-hostable), and credential are present', () => {
  const empty = defaultDraftForProvider('github')
  assert.equal(canTestDraft(empty), false)
  assert.match(draftBlockedReason(empty) ?? '', /name/i)

  const named = { ...empty, label: 'GH' }
  assert.match(draftBlockedReason(named) ?? '', /token/i) // has name + default host, missing credential

  const ready = { ...named, secret: 'tok' }
  assert.equal(canTestDraft(ready), true)
  assert.equal(draftBlockedReason(ready), null)
})

test('Jira without a server address is not testable; Linear needs no server address', () => {
  const jira = { ...defaultDraftForProvider('jira'), label: 'J', secret: 'x' }
  assert.match(draftBlockedReason(jira) ?? '', /server address/i)
  const jiraReady = { ...jira, baseUrl: 'https://acme.atlassian.net' }
  assert.equal(canTestDraft(jiraReady), true)

  const linear = { ...defaultDraftForProvider('linear'), label: 'L', secret: 'k' }
  assert.equal(canTestDraft(linear), true)
})

test('editing any credential-affecting field changes the test key (invalidates a prior pass)', () => {
  const base = { ...defaultDraftForProvider('github'), label: 'GH', secret: 'tok' }
  const key = draftTestKey(base)
  assert.notEqual(key, draftTestKey({ ...base, secret: 'tok2' }))
  assert.notEqual(key, draftTestKey({ ...base, baseUrl: 'ghe.acme.net' }))
  assert.notEqual(key, draftTestKey({ ...base, label: 'GH 2' }))
  assert.equal(key, draftTestKey({ ...base })) // identical content ⇒ same key
})

// --- Connection-list presentation ---

test('status view maps each status to a tone, label, and recovery verb', () => {
  assert.deepEqual(connectionStatusView(connection({ status: 'connected' })), {
    tone: 'good',
    label: 'Connected',
    recovery: 'none',
  })
  assert.deepEqual(
    connectionStatusView(connection({ status: 'expired', statusReason: 'No credential configured.' })),
    { tone: 'warn', label: 'Token expired', reason: 'No credential configured.', recovery: 'reconnect' },
  )
  const unknown = connectionStatusView(connection({ status: 'unknown', statusReason: 'Rate limited (429).' }))
  assert.equal(unknown.tone, 'neutral')
  assert.equal(unknown.reason, 'Rate limited (429).') // unknown always carries its reason
  assert.equal(unknown.recovery, 'test')
})

test('credential kind reflects auth mode and self-hosting', () => {
  assert.equal(connectionCredentialKind(connection({ provider: 'github', authMode: 'github_pat', baseUrl: null })), 'Personal access token')
  assert.equal(
    connectionCredentialKind(connection({ provider: 'github', authMode: 'github_pat', baseUrl: 'ghe.acme.net' })),
    'Self-hosted · personal access token',
  )
  assert.equal(
    connectionCredentialKind(connection({ provider: 'jira', authMode: 'jira_pat', baseUrl: 'https://jira.acme.net' })),
    'Self-hosted · personal access token',
  )
  assert.equal(
    connectionCredentialKind(connection({ provider: 'jira', authMode: 'jira_basic', baseUrl: 'https://acme.atlassian.net' })),
    'Email and API token',
  )
  assert.equal(connectionCredentialKind(connection({ provider: 'linear', authMode: 'linear_key', baseUrl: null })), 'API key')
})

test('github.com is not self-hosted; a custom GitHub host is', () => {
  assert.equal(connectionIsSelfHosted(connection({ provider: 'github', baseUrl: null })), false)
  assert.equal(connectionIsSelfHosted(connection({ provider: 'github', baseUrl: 'github.com' })), false)
  assert.equal(connectionIsSelfHosted(connection({ provider: 'github', baseUrl: 'ghe.acme.net' })), true)
})

test('host label falls back to the provider default when no baseUrl is stored', () => {
  assert.equal(connectionHostLabel(connection({ provider: 'github', baseUrl: null })), 'github.com')
  assert.equal(connectionHostLabel(connection({ provider: 'github', baseUrl: 'ghe.acme.net' })), 'ghe.acme.net')
  assert.equal(connectionHostLabel(connection({ provider: 'linear', baseUrl: null })), 'linear.app')
  assert.equal(connectionHostLabel(connection({ provider: 'jira', baseUrl: 'https://acme.atlassian.net' })), 'https://acme.atlassian.net')
})

// --- Humanized errors: raw provider messages stay behind "Show details" -------

function trackerError(overrides: Partial<TrackerError> = {}): TrackerError {
  return { kind: 'unknown', message: 'boom', ...overrides }
}

test('presentError pairs every failure class with a plain sentence and an action', () => {
  const classes: FailureClass[] = ['auth', 'rate_limit', 'network', 'not_found', 'validation', 'permission', 'unknown']
  for (const failure of classes) {
    const presented = presentError(failure)
    assert.ok(presented.title.length > 0, `${failure} has a title`)
    assert.ok(presented.hint.length > 0, `${failure} has a hint`)
    // No raw error jargon leaks into the human copy.
    assert.doesNotMatch(presented.title + presented.hint, /ENOENT|HTTP|zod|TypeError|\bError:/i)
  }
})

test('presentError folds the subject into network/not_found and honours retry-after', () => {
  assert.equal(presentError('network', { subject: 'Jira' }).title, 'Couldn’t reach Jira.')
  assert.equal(presentError('network').title, 'Couldn’t connect.')
  assert.equal(presentError('not_found', { subject: 'GitHub' }).title, 'GitHub couldn’t be found.')
  assert.match(presentError('rate_limit', { retryAfterSeconds: 30 }).hint, /30 seconds/)
  assert.doesNotMatch(presentError('rate_limit').hint, /\d/)
})

test('presentTrackerError humanizes each kind and keeps the raw message as detail', () => {
  const cases: Array<[TrackerError['kind'], RegExp]> = [
    ['auth', /didn’t accept this connection/],
    ['rate_limit', /Too many requests/],
    ['network', /Couldn’t reach GitHub/],
    ['not_found', /wasn’t found in GitHub/],
    ['not_configured', /No GitHub connection is set up/],
    ['unsupported', /doesn’t support this action/],
    ['unknown', /Something went wrong/],
  ]
  for (const [kind, titlePattern] of cases) {
    const presented = presentTrackerError(trackerError({ kind, provider: 'github', message: 'ENOENT: raw dump' }))
    assert.match(presented.title, titlePattern, `${kind} title`)
    // The raw string is preserved for Show details, never in the plain sentence.
    assert.equal(presented.detail, 'ENOENT: raw dump')
    assert.doesNotMatch(presented.title + presented.hint, /ENOENT/)
  }
})

test('presentTrackerError degrades gracefully without a provider or message', () => {
  const presented = presentTrackerError(trackerError({ kind: 'auth', provider: undefined, message: '   ' }))
  assert.equal(presented.title, 'That connection was refused.')
  assert.equal(presented.detail, 'No further detail was reported.')
})

let failures = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`ok   - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL - ${name}`)
    console.error(err instanceof Error ? err.stack : err)
  }
}
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} test(s) passed`)
