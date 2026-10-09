// Smoke test: the BUILT module loads the way SprintEngine Studio loads it,
// registers something, declares the permissions and dependencies the calls
// it makes need, and everything it registers renders. Run `npm run build`
// first (`npm run check` does, in order).
//
// It loads module/dist exactly as installed — the renderer bundle as ESM, the
// main bundle as CommonJS — against the SDK's fake hosts
// (`@sprintengine/module-sdk/testing`), which hold a module to the host's
// rules: the permissions the host checks are refused without their
// declaration, storage keeps the host's key pattern and size cap, and the
// renderer → main bridge needs "module:bridge". `@sprintengine/module-sdk/ui`
// and `/surface` resolve to a kit that draws what it is given, so a door that
// throws while rendering fails here instead of in the app.
//
// Your own tests are TypeScript, in test/*.test.ts: `npm test` builds them
// with esbuild (`npm run build:test`) and runs them beside this file.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkHostApiCompatibility,
  dependsOnReaches,
  moduleServiceRequirement,
  validateThirdPartyModuleManifest,
} from '@sprintengine/module-sdk'
import { createFakeMainHost, createFakeRendererHost, installTestingKit } from '@sprintengine/module-sdk/testing'

installTestingKit()

const projectDir = fileURLToPath(new URL('..', import.meta.url))
const moduleDir = join(projectDir, 'module')
const raw = JSON.parse(readFileSync(join(moduleDir, 'manifest.json'), 'utf8'))
const BRIDGE_PERMISSIONS = ['module:bridge', 'ipc:invoke']

const undeclaredMessage = (uses) =>
  uses
    .map(
      (use) =>
        `${use.what} needs ${use.needs.length > 1 ? 'one of ' : ''}${use.needs.map((p) => `"${p}"`).join(', ')}` +
        (use.checked ? ' (the host refuses it without)' : ' (declare it: the person is told what the module does)'),
    )
    .join('\n')

/** Read the built entry and check it is bundled the way the host loads it. */
function builtEntry(kind) {
  const entry = raw.entry?.[kind]
  const path = join(moduleDir, entry)
  assert.ok(existsSync(path), `${entry} is missing — run \`npm run build\` first.`)
  const source = readFileSync(path, 'utf8')
  assert.ok(
    !source.includes('is provided by the host at runtime'),
    `${entry} bundled a host-provided package instead of leaving it external. Check the esbuild --external flags.`,
  )
  // The installed module has no node_modules, and the host answers only the
  // host-provided specifiers: the SDK's own root must be bundled in.
  assert.ok(
    !/(from|require\()\s*["']@sprintengine\/module-sdk["']/.test(source),
    `${entry} imports "@sprintengine/module-sdk" at runtime; bundle it (do not mark the root specifier external).`,
  )
  return { entry, path, source }
}

test('the manifest is one the app accepts', () => {
  const result = validateThirdPartyModuleManifest(raw)
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues, null, 2))
  assert.deepEqual(checkHostApiCompatibility({ ...raw, source: 'third-party' }), { ok: true })
  assert.equal(raw.source, 'third-party')
})

// The main half, loaded once and shared with the renderer's bridge.
let main

if (raw.entry?.main) {
  test('entry.main loads, registers, and declares what it uses', async () => {
    const { entry, path, source } = builtEntry('main')
    assert.ok(!/require\(["']react/.test(source), `${entry} requires React; entry.main runs in the main process.`)
    const loaded = createRequire(import.meta.url)(path)
    assert.equal(typeof loaded.registerMain, 'function', `${entry} must export registerMain(host).`)

    main = createFakeMainHost({ manifest: raw })
    await loaded.registerMain(main.host)

    const contributed =
      main.ipc.channels().length + main.tools.list().length + main.skills.registered.length + main.sidecars.length
    assert.ok(contributed > 0, `registering ${entry} contributed nothing.`)

    for (const channel of main.ipc.channels()) {
      assert.ok(channel.startsWith(`${raw.id}:`), `IPC channel "${channel}" must start with "${raw.id}:".`)
    }
    if (raw.entry?.renderer && main.ipc.channels().length > 0) {
      assert.ok(
        BRIDGE_PERMISSIONS.some((permission) => main.permissions.has(permission)),
        'host.invoke from the renderer to these channels needs the "module:bridge" permission.',
      )
    }

    // A service resolved while registering must have its provider loaded
    // first; one resolved later (in a handler) need not.
    for (const key of main.resolved) {
      const requirement = moduleServiceRequirement(key)
      if (!requirement) continue
      assert.ok(
        dependsOnReaches(raw.dependsOn, requirement.providedBy),
        `${key} (${requirement.via}) is resolved while registering, so "dependsOn" must include ` +
          `"${requirement.providedBy}" — or resolve it inside the handler that uses it.`,
      )
    }
    assert.equal(main.undeclared.length, 0, undeclaredMessage(main.undeclared))
  })
}

if (raw.entry?.renderer) {
  let renderer

  test('entry.renderer loads and registers', async () => {
    const { entry, path } = builtEntry('renderer')
    const loaded = await import(pathToFileURL(path).href)
    assert.equal(typeof loaded.registerRenderer, 'function', `${entry} must export registerRenderer(host).`)
    renderer = createFakeRendererHost(main ? { manifest: raw, main } : { manifest: raw })
    await loaded.registerRenderer(renderer.host)
    const contributed = Object.values(renderer.registrations).some((registered) =>
      Array.isArray(registered) ? registered.length > 0 : registered.size > 0,
    )
    assert.ok(contributed, `registering ${entry} contributed nothing.`)
  })

  test('everything entry.renderer registered renders', async (t) => {
    assert.ok(renderer, 'entry.renderer did not load (see above).')
    const { registrations, render } = renderer
    const targets = [
      ...registrations.globalSurfaces.map((surface) => [`door "${surface.id}"`, () => render.surface(surface.id)]),
      ...registrations.modalSurfaces.map((surface) => [`modal "${surface.id}"`, () => render.modal(surface.id)]),
      ...[...registrations.panels.keys()].map((id) => [`panel "${id}"`, () => render.panel(id)]),
      ...registrations.settingsSections.map((section) => [
        `settings section "${section.id}"`,
        () => render.settings(section.id),
      ]),
      ...registrations.topBarItems.map((item) => [`top-bar item "${item.id}"`, () => render.topBar(item.id)]),
      ...registrations.sidebarNavEntries.map((item) => [`sidebar entry "${item.id}"`, () => render.navEntry(item.id)]),
    ]
    for (const [label, draw] of targets) {
      await t.test(`${label} renders`, async () => {
        const html = await draw()
        assert.ok(html.length > 0, `${label} rendered nothing.`)
      })
    }
  })

  test('entry.renderer uses only what the manifest declares', () => {
    assert.ok(renderer, 'entry.renderer did not load (see above).')
    assert.equal(renderer.undeclared.length, 0, undeclaredMessage(renderer.undeclared))
  })
}
