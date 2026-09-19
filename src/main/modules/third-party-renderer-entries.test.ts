import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'

import type { CapabilityManifest, ThirdPartyRendererEntriesResult } from '../../shared/modules/manifest'
import { THIRD_PARTY_RENDERER_ENTRIES_CHANNEL } from '../../shared/modules/manifest'
import { canonicalManifestPayload } from '../../shared/modules/third-party-manifest'
import { createMainKernel } from '../module-host/main-host'
import { manifestFingerprint, type ModuleTrustContext } from './module-signature'
import {
  collectThirdPartyRendererEntries,
  registerThirdPartyRendererEntryIpc,
  rendererEntryView,
} from './third-party-renderer-entries'
import { discoverUserModules, type InstalledModule } from './user-module-registry'
import { test } from 'vitest'

test('third-party-renderer-entries', async () => {
  const EMPTY_TRUST: ModuleTrustContext = { trustedModules: new Map() }
  const ABSOLUTE_PATH_PATTERN = /(^|[\s'"])(?:\/[\w.-]|[A-Za-z]:\\)/

  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-renderer-entries-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function writeModule(
    root: string,
    id: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {},
  ): Promise<void> {
    const dir = join(root, id)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ id, displayName: `Module ${id}`, version: 1, ...manifest }),
    )
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content)
    }
  }

  // Sign the normalized (post-parse) manifest shape and write it back so the
  // reparsed manifest's canonical payload matches the signed bytes.
  async function writeSignedModule(
    root: string,
    id: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {},
  ): Promise<CapabilityManifest> {
    await writeModule(root, id, manifest, files)
    const { modules } = await discoverUserModules(root, EMPTY_TRUST)
    const parsed = modules.find((module) => module.manifest.id === id)?.manifest
    assert.ok(parsed, `fixture module "${id}" must parse`)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(canonicalManifestPayload(parsed), 'utf8'), privateKey).toString('base64')
    const signed: CapabilityManifest = {
      ...parsed,
      signature: {
        algorithm: 'ed25519',
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        signature,
      },
    }
    await writeFile(join(root, id, 'manifest.json'), JSON.stringify(signed))
    return signed
  }

  async function trustOf(root: string, id: string): Promise<ModuleTrustContext> {
    const { modules } = await discoverUserModules(root, EMPTY_TRUST)
    const manifest = modules.find((module) => module.manifest.id === id)?.manifest
    assert.ok(manifest, `fixture module "${id}" must parse`)
    return { trustedModules: new Map([[id, manifestFingerprint(manifest)]]) }
  }

  // Only trusted modules are servable; signed-pending, unsigned, and invalid
  // stay blocked with their existing statuses.
  async function testTrustGateMatrix(): Promise<void> {
    await withTempDir(async (root) => {
      const bundle = { 'renderer.js': 'export function registerRenderer() {}' }
      const entry = { entry: { renderer: 'renderer.js' } }
      await writeModule(root, 'approved', entry, bundle)
      await writeModule(root, 'unapproved', entry, bundle)
      await writeSignedModule(root, 'pending', entry, bundle)
      const tamperTarget = await writeSignedModule(root, 'tampered', entry, bundle)
      await writeFile(
        join(root, 'tampered', 'manifest.json'),
        JSON.stringify({ ...tamperTarget, displayName: 'Evil module' }),
      )

      const trust = await trustOf(root, 'approved')
      const { modules } = await discoverUserModules(root, trust)
      const statuses = Object.fromEntries(modules.map((module) => [module.manifest.id, module.trust.status]))
      assert.deepEqual(statuses, {
        approved: 'trusted',
        pending: 'signed',
        tampered: 'invalid',
        unapproved: 'unsigned',
      })

      const served = await collectThirdPartyRendererEntries(modules)
      assert.deepEqual(
        served.entries.map((served) => served.id),
        ['approved'],
      )
      assert.equal(served.entries[0].code, 'export function registerRenderer() {}')
      assert.deepEqual(served.failures, {}, 'trust-blocked modules are not serving failures')

      const views = Object.fromEntries(modules.map((module) => [module.manifest.id, rendererEntryView(module)]))
      assert.equal(views.approved.availability, 'available')
      assert.equal(views.pending.availability, 'blocked')
      assert.equal(views.unapproved.availability, 'blocked')
      assert.equal(views.tampered.availability, 'blocked')
    })
  }

  // entry.renderer escaping the module root is rejected with an explicit error
  // that never leaks an absolute path. Manifest validation already rejects ".."
  // and absolute entry strings at parse time (isSafeRelativePath), so this
  // exercises the defense-in-depth containment layer with constructed
  // InstalledModule fixtures, as if a crafted manifest slipped past parsing.
  async function testContainment(): Promise<void> {
    await withTempDir(async (root) => {
      await writeFile(join(root, 'escape.js'), 'export {}')
      const moduleRoot = join(root, 'crafted')
      await mkdir(moduleRoot, { recursive: true })
      const escapingEntries: Record<string, string> = {
        traversal: '../escape.js',
        'nested-traversal': 'nested/../../escape.js',
        absolute: join(root, 'escape.js'),
        'module-root-itself': '.',
      }

      for (const [id, renderer] of Object.entries(escapingEntries)) {
        const crafted: InstalledModule = {
          manifest: {
            id,
            displayName: `Crafted ${id}`,
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            entry: { renderer },
          },
          moduleRoot,
          trust: { status: 'trusted' },
        }
        const view = rendererEntryView(crafted)
        assert.equal(view.availability, 'error', `${id} entry must be rejected`)
        assert.equal(view.message, 'entry.renderer must resolve inside the module root.')
        assert.doesNotMatch(view.message ?? '', ABSOLUTE_PATH_PATTERN)

        const served = await collectThirdPartyRendererEntries([crafted])
        assert.deepEqual(served.entries, [], `${id} entry is never served, even for a trusted module`)
        assert.equal(served.failures[id], 'entry.renderer must resolve inside the module root.')
      }
    })
  }

  // The parser front line: a manifest declaring ".." or absolute entry paths is
  // rejected before it ever becomes an installed module.
  async function testManifestValidationRejectsEscapingEntries(): Promise<void> {
    await withTempDir(async (root) => {
      await writeModule(root, 'traversal', { entry: { renderer: '../escape.js' } })
      await writeModule(root, 'absolute', { entry: { renderer: join(root, 'escape.js') } })
      const { modules, rejected } = await discoverUserModules(root, EMPTY_TRUST)
      assert.deepEqual(modules, [])
      assert.equal(rejected.length, 2)
      for (const rejection of rejected) {
        assert.match(rejection.issues[0].message, /safe relative path/)
      }
    })
  }

  // Content-bound trust: tampering with a trusted module's manifest removes it
  // from the servable set (invalid when signed; trust-void when unsigned).
  async function testTamperRemovesFromServableSet(): Promise<void> {
    await withTempDir(async (root) => {
      const signed = await writeSignedModule(
        root,
        'demo',
        { entry: { renderer: 'renderer.js' } },
        { 'renderer.js': 'export {}' },
      )
      const trust = await trustOf(root, 'demo')

      const before = await discoverUserModules(root, trust)
      assert.equal(before.modules[0].trust.status, 'trusted')
      assert.equal((await collectThirdPartyRendererEntries(before.modules)).entries.length, 1)

      // Tamper a signed field on disk: permissions escalation under a trusted id.
      await writeFile(
        join(root, 'demo', 'manifest.json'),
        JSON.stringify({ ...signed, permissions: ['process:spawn'] }),
      )
      const after = await discoverUserModules(root, trust)
      assert.equal(after.modules[0].trust.status, 'invalid')
      const served = await collectThirdPartyRendererEntries(after.modules)
      assert.deepEqual(served.entries, [], 'a tampered manifest is no longer servable')
      assert.equal(rendererEntryView(after.modules[0]).availability, 'blocked')
    })
  }

  async function testMissingBundleAndNoEntry(): Promise<void> {
    await withTempDir(async (root) => {
      await writeModule(root, 'missing-bundle', { entry: { renderer: 'renderer.js' } })
      await writeModule(root, 'manifest-only', {})
      const trust = await trustOf(root, 'missing-bundle')
      const { modules } = await discoverUserModules(root, trust)

      const missing = modules.find((module) => module.manifest.id === 'missing-bundle')!
      const view = rendererEntryView(missing)
      assert.equal(view.availability, 'error')
      assert.equal(view.message, 'entry.renderer bundle file is missing.')
      assert.doesNotMatch(view.message ?? '', ABSOLUTE_PATH_PATTERN)

      const manifestOnly = modules.find((module) => module.manifest.id === 'manifest-only')!
      assert.equal(rendererEntryView(manifestOnly).availability, 'none')

      const served = await collectThirdPartyRendererEntries(modules)
      assert.deepEqual(served.entries, [])
      assert.equal(served.failures['missing-bundle'], 'entry.renderer bundle file is missing.')
      assert.equal('manifest-only' in served.failures, false)
    })
  }

  // The serving channel is registered through the module-host kernel: ownership
  // is recorded, and the handler returns only trusted entries.
  async function testKernelIpcSurface(): Promise<void> {
    await withTempDir(async (root) => {
      await writeModule(root, 'approved', { entry: { renderer: 'renderer.js' } }, { 'renderer.js': 'export {}' })
      await writeModule(root, 'unapproved', { entry: { renderer: 'renderer.js' } }, { 'renderer.js': 'export {}' })
      const trust = await trustOf(root, 'approved')

      const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
      const ipcMain = {
        handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
          handlers.set(channel, handler)
        },
      } as unknown as IpcMain
      const kernel = createMainKernel(ipcMain)
      registerThirdPartyRendererEntryIpc(kernel.hostFor('@host'), {
        discoverModules: () => discoverUserModules(root, trust),
      })

      assert.equal(kernel.ownedChannels().get(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL), '@host')
      const handler = handlers.get(THIRD_PARTY_RENDERER_ENTRIES_CHANNEL)
      assert.ok(handler, 'channel handler is registered on ipcMain')
      const result = (await handler({} as IpcMainInvokeEvent)) as ThirdPartyRendererEntriesResult
      assert.deepEqual(
        result.entries.map((entry) => entry.id),
        ['approved'],
      )
    })
  }

  async function main(): Promise<void> {
    await testTrustGateMatrix()
    await testContainment()
    await testManifestValidationRejectsEscapingEntries()
    await testTamperRemovesFromServableSet()
    await testMissingBundleAndNoEntry()
    await testKernelIpcSurface()
    console.log('third-party-renderer-entries tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
