// `@sprintengine/module-sdk/testing`: the fake hosts hold a module to the
// host's rules, and the pass-through kit renders a door in Node.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { createElement, lazy } from 'react'
import { describe, test } from 'vitest'

import { getConversationService } from '../src/conversation.js'
import { getGitHubService, getSecretsService } from '../src/brokers.js'
import {
  getCompanionAgentsService,
  getModuleStorage,
  getScheduledAgentsService,
  WorkspaceContextToken,
  WorkspaceServiceToken,
  type ScheduledAgentDraft,
} from '../src/index.js'
import { MODULE_SERVICE_REQUIREMENTS } from '../src/services.js'
import { createFakeMainHost, createFakeRendererHost, renderToHtml } from '../src/testing.js'
import { SERVICE_FAKES } from '../src/testing-services.js'
import * as kit from '../src/testing-kit.js'

const ROOT = '/Users/dev/projects/app'

describe('createFakeMainHost', () => {
  test('has a fake for every service the SDK publishes, and nothing else', () => {
    assert.deepEqual(
      Object.keys(SERVICE_FAKES).sort(),
      MODULE_SERVICE_REQUIREMENTS.map((requirement) => requirement.key).sort(),
    )
  })

  test('storage applies the host’s key pattern, root rule and 1 MB cap', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['storage'], storage: { global: { seeded: 1 } } })
    const storage = getModuleStorage(fake.host)
    assert.deepEqual(await storage.get({ key: 'seeded' }), { ok: true, value: 1, found: true })
    assert.equal((await storage.get({ key: 'Bad Key' })).ok, false)
    assert.equal(((await storage.set({ key: 'Bad Key', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(((await storage.set({ key: 'con', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(
      ((await storage.set({ key: 'a', value: 1, workspaceRoot: 'relative/root' })) as { code?: string }).code,
      'invalid_workspace_root',
    )
    assert.equal(
      ((await storage.set({ key: 'big', value: 'x'.repeat(1024 * 1024) })) as { code?: string }).code,
      'value_too_large',
    )
    assert.equal(((await storage.set({ key: 'undef', value: undefined })) as { code?: string }).code, 'invalid_value')

    const value = { list: [1, 2] }
    assert.deepEqual(await storage.set({ key: 'doc', value, workspaceRoot: ROOT }), { ok: true })
    value.list.push(3)
    assert.deepEqual(fake.services.storage.peek('doc', ROOT), { list: [1, 2] }, 'stored as JSON, not by reference')
    assert.deepEqual(await storage.list({ workspaceRoot: ROOT }), { ok: true, keys: ['doc'] })
    assert.deepEqual(await storage.list(), { ok: true, keys: ['seeded'] }, 'the global store is its own scope')
    assert.deepEqual(await storage.delete({ key: 'doc', workspaceRoot: ROOT }), { ok: true, deleted: true })
    assert.deepEqual(fake.undeclared, [])
  })

  test('a service used without its permission is reported, and the host’s checked ones refuse', async () => {
    const fake = createFakeMainHost({ moduleId: 'quiet', permissions: [] })
    getModuleStorage(fake.host)
    assert.deepEqual(fake.undeclared, [{ what: 'core.module-storage', needs: ['storage'], checked: false }])

    const conversations = getConversationService(fake.host)
    const created = await conversations.create({ workspaceId: 'ws-app' })
    assert.equal(created.ok, false)
    assert.equal(!created.ok && created.code, 'permission_missing')
    assert.throws(() => conversations.list(), /must declare the "conversation:read" permission/)

    const github = await getGitHubService(fake.host).request({ route: '/user' })
    assert.equal(!github.ok && github.code, 'permission_missing')
    const secret = await getSecretsService(fake.host).set('key', 'v', { allowedOrigins: ['https://api.example.com'] })
    assert.equal(!secret.ok && secret.code, 'permission_missing')
    assert.throws(
      () =>
        getCompanionAgentsService(fake.host).attach({
          workspaceId: 'ws-app',
          agentId: 'guide',
          name: 'Guide',
          workspaceRoot: ROOT,
          systemPrompt: 'Help.',
        }),
      /must declare the "agents:companion" permission/,
    )
  })

  test('only published services resolve, and a removed provider throws as the host does', () => {
    const fake = createFakeMainHost({ moduleId: 'notes', services: { 'github.module-service': null } })
    assert.throws(
      () => fake.host.requireService({ key: 'core.terminal-runtime' }),
      /Service "core.terminal-runtime" is not available to third-party modules/,
    )
    assert.throws(
      () => fake.host.requireService({ key: 'github.module-service' }),
      /requires service "github.module-service", which no enabled module provides/,
    )
    assert.equal(fake.host.getService({ key: 'github.module-service' }), undefined)
    const own = fake.host.provideService({ key: 'notes.index' }, () => ({ size: 3 }))
    assert.equal(fake.host.requireService({ key: 'notes.index' }), own)
  })

  test('the bridge reaches own channels only, with module:bridge, and clones like IPC', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: [] })
    fake.host.registerIpc('notes:echo', (_event, payload) => ({ got: payload }))
    await assert.rejects(fake.ipc.invoke('other:echo'), /may only invoke its own channels/)
    await assert.rejects(
      fake.ipc.invoke('notes:missing'),
      (error: Error & { code?: string }) => error.code === 'unknown_channel',
    )
    await assert.rejects(
      fake.ipc.invoke('notes:echo', 1),
      (error: Error & { code?: string }) => error.code === 'permission_missing' && /module:bridge/.test(error.message),
    )
    fake.permissions.add('module:bridge')
    assert.deepEqual(await fake.ipc.invoke('notes:echo', { a: 1 }), { got: { a: 1 } })
    fake.permissions.delete('module:bridge')
    fake.permissions.add('ipc:invoke')
    assert.deepEqual(await fake.ipc.invoke('notes:echo', 2), { got: 2 }, 'the broad legacy scope still opens it')
    fake.host.registerIpc('notes:fn', () => ({ run() {} }))
    await assert.rejects(fake.ipc.invoke('notes:fn'), /could not be cloned/, 'a result IPC cannot carry fails')
  })

  test('MCP tools need mcp:tools, and a call reaches the handler with agent metadata', async () => {
    const tools = [
      {
        name: 'notes_count',
        description: 'Count notes',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: async (args: Record<string, unknown>, context?: { metadata: { workspaceId?: string } }) => ({
          content: [{ type: 'text' as const, text: `${String(args.prefix)}:${context?.metadata.workspaceId}` }],
        }),
      },
    ]
    assert.throws(
      () => createFakeMainHost({ moduleId: 'notes' }).host.registerMcpTools(tools),
      /must declare the "mcp:tools" permission/,
    )
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['mcp:tools'] })
    fake.host.registerMcpTools(tools)
    assert.deepEqual(await fake.tools.call('notes_count', { prefix: 'n' }), {
      content: [{ type: 'text', text: 'n:ws-app' }],
    })
    await assert.rejects(fake.tools.call('nope'), /No MCP tool "nope"/)
  })

  test('conversations: owned chats, events, presets capped, retries answered once', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['conversation:operate'] })
    const chats = getConversationService(fake.host)
    const lists: number[] = []
    chats.watch(undefined, (list) => lists.push(list.length))

    const missing = await chats.create({ workspaceId: 'nowhere' })
    assert.equal(!missing.ok && missing.code, 'unknown_workspace')
    const created = await chats.create({
      workspaceId: 'ws-app',
      prompt: 'Plan it',
      permissionPreset: 'bypass',
      commandId: 'c1',
    })
    assert.ok(created.ok)
    const again = await chats.create({ workspaceId: 'ws-app', prompt: 'Plan it', commandId: 'c1' })
    assert.ok(
      again.ok && again.conversation.agentId === created.conversation.agentId,
      'a retried create finds the first chat',
    )
    assert.equal(created.conversation.permissionPreset, 'auto', 'bypass is lowered to the auto ceiling')

    const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    const seen: string[] = []
    chats.subscribe(ref, (event) => seen.push(event.type))
    fake.services.conversations.emitEvent(ref, { type: 'turn_started' })
    fake.services.conversations.emitEvent(ref, { type: 'content_delta', payload: { text: 'Done' } })
    fake.services.conversations.emitEvent(ref, { type: 'turn_completed' })
    assert.deepEqual(seen, ['turn_started', 'content_delta', 'turn_completed'])
    assert.equal(chats.list()[0]?.status, 'ready')
    const transcript = await chats.transcript(ref)
    assert.ok(transcript.ok)
    assert.deepEqual(
      transcript.events.map((event) => event.type),
      ['session_started', 'user_message', 'turn_started', 'content_delta', 'turn_completed'],
    )
    assert.ok(lists.length >= 3, 'watchers hear creates and status changes')

    const frames: string[] = []
    chats.follow(ref, { afterSeq: 3 }, (frame) => frames.push(frame.type))
    assert.deepEqual(frames, ['event', 'event', 'synchronized'], 'a known cursor gets only what came after it')

    fake.services.conversations.addForeign({ workspaceId: 'ws-app', agentId: 'person-chat' })
    assert.throws(
      () => chats.subscribe({ workspaceId: 'ws-app', agentId: 'person-chat' }, () => {}),
      /was started by this module/,
    )
    const foreignSend = await chats.send({ workspaceId: 'ws-app', agentId: 'person-chat' }, { message: 'hi' })
    assert.equal(!foreignSend.ok && foreignSend.code, 'not_owned')

    assert.deepEqual(await chats.send(ref, { message: 'And then?' }), { ok: true })
    assert.deepEqual(fake.services.conversations.get(ref)?.sent, ['And then?'])
    fake.services.conversations.failNextCreate('no_cli_selected')
    const refused = await chats.create({ workspaceId: 'ws-app' })
    assert.equal(!refused.ok && refused.code, 'no_cli_selected')
  })

  test('scheduled agents: owned, validated, fired, and a one-time schedule closes after its run', async () => {
    let clock = Date.parse('2026-10-09T10:00:00Z')
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['scheduled-agents.manage'], now: () => clock })
    const scheduled = getScheduledAgentsService(fake.host)
    const changes: number[] = []
    scheduled.onChanged((agents) => changes.push(agents.length))
    const draft: ScheduledAgentDraft = {
      prompt: 'Standup',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      folderPath: ROOT,
      hostId: 'local',
      cli: 'claude',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const created = await scheduled.create(draft)
    assert.ok(created.ok && created.agent.ownerModuleId === 'board')
    const past = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock - 1 } })
    assert.deepEqual(past, { ok: false, message: 'That time has already passed.' })
    const once = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock + 60_000 } })
    assert.ok(once.ok)
    clock += 60_000
    const run = fake.services.scheduledAgents.fire(once.agent.id)
    assert.ok(run.ok)
    assert.deepEqual(
      (await scheduled.list()).map((agent) => agent.id),
      [created.agent.id],
    )
    assert.deepEqual(changes, [1, 2, 1])
    assert.deepEqual(await scheduled.remove('scheduled-99'), {
      ok: false,
      message: 'No scheduled agent "scheduled-99".',
    })
  })

  test('secrets go only to their origins over https, and an echoed value comes back redacted', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['secrets'] })
    const secrets = getSecretsService(fake.host)
    const http = await secrets.set('token', 'abc', { allowedOrigins: ['http://api.example.com'] })
    assert.equal(!http.ok && http.code, 'origin_not_allowed')
    assert.deepEqual(await secrets.set('token', 'abc', { allowedOrigins: ['https://api.example.com'] }), { ok: true })
    assert.equal(await secrets.has('token'), true)
    fake.services.secrets.respond((request) => ({ status: 200, body: `you sent ${request.headers.Authorization}` }))
    const elsewhere = await secrets.fetchWithSecret('token', 'https://evil.example/x', {
      placement: { header: 'Authorization' },
    })
    assert.equal(!elsewhere.ok && elsewhere.code, 'origin_not_allowed')
    const sent = await secrets.fetchWithSecret('token', 'https://api.example.com/me', {
      placement: { header: 'Authorization', scheme: 'Bearer' },
    })
    assert.deepEqual(sent, { ok: true, status: 200, headers: {}, body: 'you sent Bearer [redacted]' })
    assert.equal(fake.services.secrets.requests[0]?.headers.Authorization, 'Bearer abc')
  })

  test('GitHub answers what was scripted, 404 otherwise, and not_signed_in when signed out', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['github'] })
    const github = getGitHubService(fake.host)
    fake.services.github.respond('GET', '/repos/{owner}/{repo}/pulls', { ok: true, status: 200, data: [{ number: 1 }] })
    assert.deepEqual(
      await github.request({ route: '/repos/{owner}/{repo}/pulls', params: { owner: 'acme', repo: 'app' } }),
      {
        ok: true,
        status: 200,
        data: [{ number: 1 }],
      },
    )
    const unscripted = await github.request({ route: '/user' })
    assert.equal(!unscripted.ok && unscripted.status, 404)
    fake.services.github.setSignedIn(false)
    const signedOut = await github.request({ route: '/repos/{owner}/{repo}/pulls' })
    assert.equal(!signedOut.ok && signedOut.code, 'not_signed_in')
    assert.deepEqual(await github.status(), { signedIn: false })
  })

  test('companions attach once per id and retry an invalid structured answer', async () => {
    const fake = createFakeMainHost({ moduleId: 'review', permissions: ['agents:companion'] })
    const companions = getCompanionAgentsService(fake.host)
    const spec = { workspaceId: 'ws-app', agentId: 'guide', name: 'Guide', workspaceRoot: ROOT, systemPrompt: 'Help.' }
    const handle = companions.attach(spec)
    assert.equal(companions.attach(spec), handle)
    assert.equal(handle.status(), 'absent', 'attach never spawns')
    fake.services.companions.respond(({ attempt }) => (attempt === 0 ? { wrong: true } : { score: 3 }))
    const score = await handle.runStructured({
      prompt: 'Rate it',
      validate: (raw) =>
        typeof (raw as { score?: unknown }).score === 'number'
          ? { ok: true, value: (raw as { score: number }).score }
          : { ok: false, errors: ['score must be a number'] },
    })
    assert.equal(score, 3)
    assert.equal(fake.services.companions.prompts.length, 2)
  })

  test('workspaces answer null before hydration, as after launch', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['ipc:workspace-read', 'ipc:workspace-write'] })
    const context = fake.host.requireService(WorkspaceContextToken)
    fake.services.workspaces.setHydrated(false)
    assert.equal(await context.get('ws-app'), null)
    fake.services.workspaces.setHydrated(true)
    assert.equal((await context.get('ws-app'))?.folderPath, ROOT)
    const created = await fake.host
      .requireService(WorkspaceServiceToken)
      .create({ name: 'Docs', folderPath: '/Users/dev/docs' })
    assert.ok(created.ok)
    assert.equal((await context.list()).length, 2)
  })

  test('notify and emit are validated as the host validates them; hooks run in order', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes' })
    fake.host.notify({ severity: 'info', title: '  Saved  ' })
    assert.deepEqual(fake.notifications, [{ severity: 'info', title: 'Saved' }])
    assert.throws(() => fake.host.notify({ severity: 'loud' as never, title: 'x' }), /severity/)
    assert.throws(() => fake.host.emit(''), /needs a topic/)
    assert.throws(() => fake.host.emit('changed', { fn() {} }), /could not be cloned/)
    fake.host.emit('changed', { id: 1 })
    assert.deepEqual(fake.emitted, [{ topic: 'changed', payload: { id: 1 } }])
    const order: string[] = []
    fake.host.onShutdown(() => void order.push('shutdown-1'))
    fake.host.onShutdown(() => void order.push('shutdown-2'))
    fake.host.onShutdownBegin(() => void order.push('begin'))
    fake.host.onStartup(() => void order.push('startup'))
    await fake.startup()
    await fake.shutdown()
    assert.deepEqual(order, ['startup', 'begin', 'shutdown-2', 'shutdown-1'])
  })
})

describe('createFakeRendererHost', () => {
  test('records registrations, renders a door with the kit, and bridges to the main fake', async () => {
    const main = createFakeMainHost({ moduleId: 'notes', permissions: ['module:bridge', 'conversation:operate'] })
    main.host.registerIpc('notes:list', () => ['First note'])
    const renderer = createFakeRendererHost({ main })
    const Door = () =>
      createElement(
        kit.GlobalSurfaceShell,
        { ariaLabel: 'Notes', bar: { title: 'Notes' } },
        createElement(kit.SurfaceCanvasState, { kind: 'empty', glyph: null, title: 'Nothing yet' }),
      )
    renderer.host.registerGlobalSurface({
      id: 'notes',
      label: 'Notes',
      Component: lazy(async () => ({ default: Door })),
    })
    renderer.host.registerCommand({
      id: 'notes.open',
      title: 'Open notes',
      category: 'Notes',
      scopes: ['global'],
      run() {
        renderer.host.openGlobalSurface('notes')
      },
    })

    const html = await renderer.render.surface('notes')
    assert.match(html, /data-kit="GlobalSurfaceShell"/)
    assert.match(html, /Nothing yet/)
    await renderer.runCommand('notes.open')
    assert.deepEqual(renderer.openedSurfaces, [{ kind: 'global', id: 'notes' }])

    assert.deepEqual(await renderer.host.invoke('notes:list'), ['First note'])
    const heard: unknown[] = []
    renderer.host.subscribe('changed', (payload) => heard.push(payload))
    main.host.emit('changed', { id: 2 })
    assert.deepEqual(heard, [{ id: 2 }])

    const opened = await renderer.host.openChat({ workspaceId: 'ws-app', prompt: 'Draft', send: false })
    assert.ok(opened.ok)
    assert.equal(main.services.conversations.all().length, 1, 'an openChat chat is the module’s own')
  })

  test('a component that throws fails the render', async () => {
    const renderer = createFakeRendererHost({ moduleId: 'notes' })
    renderer.host.registerTopBarItem({
      id: 'timer',
      order: 1,
      Component: () => {
        throw new Error('timer exploded')
      },
    })
    await assert.rejects(renderer.render.topBar('timer'), /timer exploded/)
  })

  test('disclosure permissions used without being declared are reported', async () => {
    const renderer = createFakeRendererHost({ moduleId: 'notes', permissions: [] })
    await renderer.host.listWorkspaces()
    renderer.host.setModuleAppState('draft', 'x')
    const chat = await renderer.host.openChat({ workspaceId: 'ws-app' })
    assert.equal(!chat.ok && chat.code, 'permission_missing')
    assert.deepEqual(
      renderer.undeclared.map((use) => [use.what, use.checked]),
      [
        ['listWorkspaces', false],
        ['setModuleAppState', false],
        ['openChat', true],
      ],
    )
  })
})

describe('the pass-through kit', () => {
  test('draws text props, elements, nested rows, and nothing for a closed drawer', async () => {
    const html = await renderToHtml(
      createElement(
        'main',
        null,
        createElement(kit.EmptyState, { title: 'No boards', body: createElement('em', null, 'Make one') }),
        createElement(kit.SurfaceRail, {
          label: 'Boards',
          rows: [{ id: 'a', title: 'Alpha', stateLine: 'Open' }],
          selectedId: null,
          onSelect() {},
          newAffordance: { label: 'New board', onActivate() {} },
        }),
        createElement(kit.Drawer, { open: false, onClose() {}, title: 'Hidden', ariaLabel: 'Hidden' }, 'secret'),
      ),
    )
    assert.match(html, /No boards/)
    assert.match(html, /<em>Make one<\/em>/)
    assert.match(html, /Alpha/)
    assert.match(html, /New board/)
    assert.doesNotMatch(html, /secret/)
  })

  test('installTestingKit routes the host-provided specifiers, so a built bundle renders in Node', () => {
    // Built the way the package ships (ESM beside each other), into the repo
    // so `react` resolves from its node_modules, and run in a child process
    // so the resolve hook does not outlive the test.
    const out = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'testing-kit-check')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const sdk = join(process.cwd(), 'packages', 'module-sdk', 'src')
    buildSync({
      entryPoints: [join(sdk, 'testing.ts'), join(sdk, 'testing-kit.ts')],
      outdir: out,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      outExtension: { '.js': '.js' },
      logLevel: 'silent',
    })
    writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
    writeFileSync(
      join(out, 'door.mjs'),
      [
        "import { createElement } from 'react'",
        "import { EmptyState } from '@sprintengine/module-sdk/ui'",
        "import { GlobalSurfaceShell } from '@sprintengine/module-sdk/surface'",
        'export const Door = () => createElement(GlobalSurfaceShell, { ariaLabel: "Door" }, createElement(EmptyState, { title: "Rendered in Node" }))',
      ].join('\n'),
    )
    writeFileSync(
      join(out, 'run.mjs'),
      [
        "import { createElement } from 'react'",
        "import { installTestingKit, renderToHtml } from './testing.js'",
        'installTestingKit()',
        "const { Door } = await import('./door.mjs')",
        'console.log(await renderToHtml(createElement(Door)))',
      ].join('\n'),
    )
    const run = spawnSync(process.execPath, [join(out, 'run.mjs')], { encoding: 'utf8' })
    rmSync(out, { recursive: true, force: true })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /data-kit="GlobalSurfaceShell"/)
    assert.match(run.stdout, /Rendered in Node/)
  })
})
