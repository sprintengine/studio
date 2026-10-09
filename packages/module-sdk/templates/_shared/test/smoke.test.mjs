// Smoke test: the BUILT module loads the way SprintEngine Studio loads it,
// registers something, and declares the permissions and dependencies the
// calls it makes at registration need. Run `npm run build` first
// (`npm run check` does, in order).
//
// It loads module/dist exactly as installed — the renderer bundle as ESM, the
// main bundle as CommonJS — against recording fake hosts, so a bundle that
// inlined a host-provided package, reached for one the host does not provide,
// or threw while registering fails here instead of in the app.
//
// Add tests of your own beside this file (node:test, `*.test.mjs`) and list
// them in package.json's "test" script.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { checkHostApiCompatibility, validateThirdPartyModuleManifest } from '@sprintengine/module-sdk'

const projectDir = fileURLToPath(new URL('..', import.meta.url))
const moduleDir = join(projectDir, 'module')
const raw = JSON.parse(readFileSync(join(moduleDir, 'manifest.json'), 'utf8'))

// The host answers these at runtime; outside it they resolve to stand-ins.
const HOST_PROVIDED = new Set([
  '@sprintengine/module-sdk/ui',
  '@sprintengine/module-sdk/surface',
  '@monaco-editor/react',
])
const HOST_KIT_FAKE = new URL('./host-kit-fake.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (HOST_PROVIDED.has(specifier)) return { url: HOST_KIT_FAKE, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// What a service key a module reaches at registration needs declared.
const SERVICE_PERMISSIONS = {
  'conversation.module-service': ['conversation:read', 'conversation:operate'],
  'module-secrets.module-service': ['secrets'],
  'github.module-service': ['github'],
  'core.module-storage': ['storage'],
  'automations.module-service': ['automations.manage'],
  'companion-agents.module-service': ['agents:companion'],
  'text-generation.module-service': ['agents:generate'],
}
const SERVICE_DEPENDENCIES = {
  'automations.provider-registry': 'automations',
  'automations.module-service': 'automations',
}

/**
 * A host that records every call. Methods it does not model answer with a
 * no-op function, which also serves as an unsubscriber; `requireService`
 * answers with a recording service, so `getConversationService(host)` and
 * friends work and their use is visible.
 */
function recordingHost(calls) {
  const known = { moduleId: raw.id, hostApiVersion: raw.engines?.hostApi ?? 1, supports: () => true }
  const recorder = (prefix) =>
    new Proxy(prefix ? {} : known, {
      get(target, property) {
        if (property in target) return target[property]
        if (typeof property !== 'string' || property === 'then') return undefined
        return (...args) => {
          calls.push({ method: prefix ? `${prefix}.${property}` : property, args })
          if (!prefix && (property === 'requireService' || property === 'getService')) return recorder(args[0]?.key)
          return () => {}
        }
      },
    })
  return recorder('')
}

const registrations = (calls) => calls.filter((call) => /(^|\.)register/.test(call.method))

test('the manifest is one the app accepts', () => {
  const result = validateThirdPartyModuleManifest(raw)
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues, null, 2))
  assert.deepEqual(checkHostApiCompatibility({ ...raw, source: 'third-party' }), { ok: true })
  assert.equal(raw.source, 'third-party')
})

for (const kind of ['renderer', 'main']) {
  const entry = raw.entry?.[kind]
  if (!entry) continue

  test(`entry.${kind} loads and registers`, async () => {
    const path = join(moduleDir, entry)
    assert.ok(existsSync(path), `${entry} is missing — run \`npm run build\` first.`)
    const source = readFileSync(path, 'utf8')
    assert.ok(
      !source.includes('is provided by the host at runtime'),
      `${entry} bundled a host-provided package instead of leaving it external. Check the esbuild --external flags.`,
    )
    // The installed module has no node_modules, and the host answers only the
    // specifiers above: the SDK's own root must be bundled in, not left bare.
    assert.ok(
      !/(from|require\()\s*["']@sprintengine\/module-sdk["']/.test(source),
      `${entry} imports "@sprintengine/module-sdk" at runtime; bundle it (do not mark the root specifier external).`,
    )

    const calls = []
    const host = recordingHost(calls)
    if (kind === 'renderer') {
      const loaded = await import(pathToFileURL(path).href)
      assert.equal(typeof loaded.registerRenderer, 'function', `${entry} must export registerRenderer(host).`)
      await loaded.registerRenderer(host)
    } else {
      assert.ok(!/require\(["']react/.test(source), `${entry} requires React; entry.main runs in the main process.`)
      const loaded = createRequire(import.meta.url)(path)
      assert.equal(typeof loaded.registerMain, 'function', `${entry} must export registerMain(host).`)
      await loaded.registerMain(host)
    }
    assert.ok(registrations(calls).length > 0, `registering ${entry} contributed nothing.`)

    const declared = new Set(raw.permissions ?? [])
    const dependsOn = new Set(raw.dependsOn ?? [])
    for (const call of calls) {
      if (call.method === 'registerMcpTools') {
        assert.ok(declared.has('mcp:tools'), 'registerMcpTools needs the "mcp:tools" permission.')
      }
      if (call.method === 'registerIpc') {
        const [channel] = call.args
        assert.ok(String(channel).startsWith(`${raw.id}:`), `IPC channel "${channel}" must start with "${raw.id}:".`)
        if (raw.entry?.renderer) {
          assert.ok(declared.has('ipc:invoke'), 'host.invoke from the renderer needs the "ipc:invoke" permission.')
        }
      }
      if (call.method === 'requireService' || call.method === 'getService') {
        const key = call.args[0]?.key
        const needs = SERVICE_PERMISSIONS[key]
        if (needs) {
          assert.ok(
            needs.some((permission) => declared.has(permission)),
            `${key} needs one of these permissions: ${needs.join(', ')}.`,
          )
        }
        const dependency = SERVICE_DEPENDENCIES[key]
        if (dependency) {
          assert.ok(dependsOn.has(dependency), `${key} needs "dependsOn": ["${dependency}"] so it loads first.`)
        }
      }
    }
  })
}
