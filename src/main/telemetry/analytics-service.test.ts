/**
 * The sender. Every gate, the collection boundary, and the failure behaviour —
 * with an injected fetch and injected timers, so nothing here opens a socket or
 * waits on a clock.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAnalyticsService,
  createNoopAnalyticsService,
  resolveTelemetryConfig,
  sanitizeProperties,
  type AnalyticsServiceDeps,
  type TelemetryConfig,
} from './analytics-service'
import { test } from 'vitest'

test('analytics-service', async () => {
  type Capture = { url: string; body: { api_key: string; batch: ReadonlyArray<Record<string, unknown>> } }

  const KEYED: TelemetryConfig = {
    projectKey: 'phc_test_key',
    host: 'https://capture.test',
    envEnabled: true,
    flushBatchSize: 2,
    maxBufferedEvents: 3,
    flushIntervalMs: 30_000,
  }

  async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sprintengine-telemetry-send-'))
    try {
      await body(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** A fetch that records what it was asked to send and answers with `status`. */
  function stubFetch(captures: Capture[], status: (() => number) | number = 200): typeof fetch {
    return (async (url: unknown, init: unknown) => {
      const request = init as { body: string }
      captures.push({ url: String(url), body: JSON.parse(request.body) })
      const code = typeof status === 'function' ? status() : status
      return { ok: code >= 200 && code < 300, status: code } as Response
    }) as unknown as typeof fetch
  }

  function deps(dir: string, overrides: Partial<AnalyticsServiceDeps> = {}): AnalyticsServiceDeps {
    return {
      resolveUserDataDir: () => dir,
      isConsented: () => true,
      appVersion: '9.9.9',
      packaged: true,
      config: KEYED,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      // Timers are inert: every flush in this file is explicit, so a test can
      // never depend on when the interval happened to fire.
      timers: { setInterval: () => 'handle', clearInterval: () => undefined },
      ...overrides,
    }
  }

  async function main(): Promise<void> {
    // ---- the collection boundary -------------------------------------------

    // scalars survive
    assert.deepEqual(sanitizeProperties({ cli: 'claude-code', tasks: 3, resumed: true }), {
      cli: 'claude-code',
      tasks: 3,
      resumed: true,
    })

    // a local filesystem path is DROPPED, not redacted — the property is gone,
    // not replaced with a marker that still reports one was there
    const scrubbed = sanitizeProperties({
      cli: 'codex',
      folderPath: '/Users/someone/Clients/acme-bank/repo',
      winPath: 'C:\\Users\\someone\\secret-project',
    } as never)
    assert.deepEqual(scrubbed, { cli: 'codex' })

    // non-scalars, over-long strings, and non-finite numbers never leave
    const rejected = sanitizeProperties({
      nested: { workspace: 'acme' },
      list: [1, 2],
      when: new Date(),
      prose: 'x'.repeat(200),
      ratio: Number.NaN,
      unbounded: Number.POSITIVE_INFINITY,
      kept: 'ok',
    } as never)
    assert.deepEqual(rejected, { kept: 'ok' })

    // ---- the gates ----------------------------------------------------------

    // no project key: nothing is active and nothing is ever sent
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(
        deps(dir, { config: { ...KEYED, projectKey: '' }, fetchImpl: stubFetch(captures) }),
      )
      assert.equal(service.isActive(), false)
      service.record('app.boot')
      await service.flush()
      assert.deepEqual(captures, [], 'an unkeyed build must not open a socket')
    })

    // the environment kill switch outranks consent
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(
        deps(dir, { config: { ...KEYED, envEnabled: false }, fetchImpl: stubFetch(captures) }),
      )
      assert.equal(service.isActive(), false)
      service.record('app.boot')
      await service.flush()
      assert.deepEqual(captures, [])
    })

    // the user's toggle, read per event rather than cached at construction
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      let consented = false
      const service = createAnalyticsService(
        deps(dir, { isConsented: () => consented, fetchImpl: stubFetch(captures) }),
      )
      service.record('app.boot')
      await service.flush()
      assert.deepEqual(captures, [], 'nothing is kept while the toggle is off')

      consented = true
      service.record('app.boot')
      await service.flush()
      assert.equal(captures.length, 1, 'turning it on takes effect without a restart')
    })

    // ---- the payload --------------------------------------------------------

    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(deps(dir, { fetchImpl: stubFetch(captures) }))
      service.record('agent.launched', { cli: 'claude-code' })
      await service.flush()

      assert.equal(captures.length, 1)
      const [sent] = captures
      assert.equal(sent.url, 'https://capture.test/batch/')
      assert.equal(sent.body.api_key, 'phc_test_key')
      assert.equal(sent.body.batch.length, 1)

      const event = sent.body.batch[0] as {
        event: string
        distinct_id: string
        timestamp: string
        properties: Record<string, unknown>
      }
      assert.equal(event.event, 'agent.launched')
      assert.equal(event.timestamp, '2026-01-02T03:04:05.000Z')
      assert.match(event.distinct_id, /^[0-9a-f-]{36}$/u, 'identity is the install UUID and nothing else')
      assert.equal(event.properties.cli, 'claude-code')
      assert.equal(event.properties.appVersion, '9.9.9')
      assert.equal(event.properties.packaged, true)
      assert.equal(event.properties.platform, process.platform)
      // No person profile: the install id is the whole identity.
      assert.equal(event.properties.$process_person_profile, false)

      // every event in a session carries the same identity
      service.record('app.boot')
      await service.flush()
      const second = captures[1].body.batch[0] as { distinct_id: string }
      assert.equal(second.distinct_id, event.distinct_id)
    })

    // events are sent in batches of at most `flushBatchSize`, oldest first
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(deps(dir, { fetchImpl: stubFetch(captures) }))
      service.record('app.boot', { seq: 1 })
      service.record('agent.launched', { seq: 2 })
      service.record('app.boot', { seq: 3 })
      await service.flush()

      assert.equal(captures.length, 2, 'three events at a batch size of two is two requests')
      assert.deepEqual(
        captures.flatMap((capture) => capture.body.batch.map((event) => (event.properties as { seq: number }).seq)),
        [1, 2, 3],
      )
    })

    // ---- failure behaviour --------------------------------------------------

    // a transport failure keeps the events, in order, for the next attempt
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const diagnostics: string[] = []
      let failing = true
      const service = createAnalyticsService(
        deps(dir, {
          fetchImpl: stubFetch(captures, () => (failing ? 503 : 200)),
          logDiagnostic: (input) => diagnostics.push(input.title),
        }),
      )
      service.record('app.boot', { seq: 1 })
      service.record('agent.launched', { seq: 2 })
      await service.flush()
      assert.equal(captures.length, 1, 'a failed batch stops the drain rather than hammering the endpoint')
      assert.deepEqual(diagnostics, ['Usage data not sent'])

      failing = false
      await service.flush()
      assert.deepEqual(
        captures
          .slice(1)
          .flatMap((capture) => capture.body.batch.map((event) => (event.properties as { seq: number }).seq)),
        [1, 2],
        'the buffered events are resent, still in order',
      )
      assert.equal(diagnostics.length, 1, 'the warning is once per process, not once per flush')
    })

    // a 4xx is permanent: the batch is discarded rather than retried forever
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(deps(dir, { fetchImpl: stubFetch(captures, 401) }))
      service.record('app.boot')
      await service.flush()
      assert.equal(captures.length, 1)
      await service.flush()
      assert.equal(captures.length, 1, 'a rejected batch is not sent again')
    })

    // 429 is a "later", not a "no"
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      let code = 429
      const service = createAnalyticsService(deps(dir, { fetchImpl: stubFetch(captures, () => code) }))
      service.record('app.boot')
      await service.flush()
      code = 200
      await service.flush()
      assert.equal(captures.length, 2, 'a throttled batch is kept and retried')
    })

    // a thrown fetch is survivable
    await withUserData(async (dir) => {
      const service = createAnalyticsService(
        deps(dir, {
          fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
        }),
      )
      service.record('app.boot')
      await service.flush()
      assert.ok(true, 'flush resolves rather than rejecting when the network throws')
    })

    // overflow drops the OLDEST, so a long outage leaves the recent picture intact
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      const service = createAnalyticsService(deps(dir, { fetchImpl: stubFetch(captures) }))
      for (const seq of [1, 2, 3, 4, 5]) service.record('app.boot', { seq })
      await service.flush()
      assert.deepEqual(
        captures.flatMap((capture) => capture.body.batch.map((event) => (event.properties as { seq: number }).seq)),
        [3, 4, 5],
        'the cap is three; the two oldest went',
      )
    })

    // the flush timer lives only while the buffer has something in it
    await withUserData(async (dir) => {
      let armed = 0
      let cleared = 0
      let status = 200
      const service = createAnalyticsService(
        deps(dir, {
          fetchImpl: stubFetch([], () => status),
          timers: {
            setInterval: () => {
              armed += 1
              return `handle-${armed}`
            },
            clearInterval: () => (cleared += 1),
          },
        }),
      )
      assert.equal(armed, 0, 'nothing recorded: no timer')
      service.record('app.boot')
      service.record('app.boot')
      assert.equal(armed, 1, 'the first event arms it once')
      await service.flush()
      assert.equal(cleared, 1, 'the drain that empties the buffer disarms it')

      status = 503
      service.record('app.boot')
      assert.equal(armed, 2, 'the next event arms it again')
      await service.flush()
      assert.equal(cleared, 1, 'a failed send keeps it armed: that is the retry')
      status = 200
      await service.flush()
      assert.equal(cleared, 2)
    })

    // shutdown stops the timer, makes a last attempt, and closes the gate
    await withUserData(async (dir) => {
      const captures: Capture[] = []
      let cleared = 0
      const service = createAnalyticsService(
        deps(dir, {
          fetchImpl: stubFetch(captures),
          timers: { setInterval: () => 'handle', clearInterval: () => (cleared += 1) },
        }),
      )
      service.record('app.boot')
      await service.shutdown()
      assert.equal(cleared, 1)
      assert.equal(captures.length, 1, 'buffered events get one last send on quit')
      assert.equal(service.isActive(), false)
      service.record('app.boot')
      await service.flush()
      assert.equal(captures.length, 1, 'nothing is recorded after shutdown')
    })

    // ---- config resolution --------------------------------------------------

    const unset = resolveTelemetryConfig({})
    assert.equal(unset.projectKey, '', 'no key ships by default')
    assert.equal(unset.host, 'https://us.i.posthog.com')
    assert.equal(unset.envEnabled, true)

    const configured = resolveTelemetryConfig({
      SPRINTENGINE_POSTHOG_KEY: '  phc_from_env  ',
      SPRINTENGINE_POSTHOG_HOST: 'https://eu.i.posthog.com/',
      SPRINTENGINE_TELEMETRY_ENABLED: 'false',
    })
    assert.equal(configured.projectKey, 'phc_from_env')
    assert.equal(configured.host, 'https://eu.i.posthog.com', 'a trailing slash never becomes //batch/')
    assert.equal(configured.envEnabled, false)

    // only the exact string 'false' disables; a typo must not silently opt a
    // whole fleet out of the product default
    for (const value of ['0', 'no', 'FALSE', 'off', '']) {
      assert.equal(
        resolveTelemetryConfig({ SPRINTENGINE_TELEMETRY_ENABLED: value }).envEnabled,
        true,
        `${JSON.stringify(value)} must not read as the kill switch`,
      )
    }

    // ---- the no-op ----------------------------------------------------------

    const noop = createNoopAnalyticsService()
    noop.record('app.boot', { seq: 1 })
    await noop.flush()
    await noop.shutdown()
    assert.equal(noop.isActive(), false)

    console.log('telemetry analytics-service tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
