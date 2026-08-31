import { readFile, readdir, stat } from 'fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

import type {
  ConversationProviderAdapterClassification,
  ConversationProviderListEntry,
  ConversationProviderManifest,
  LoadedConversationProvider,
  LoadedPlugin,
  PluginManifest,
  PluginManifestValidationIssue,
  PluginManifestValidationResult,
  PluginRegistryListEntry,
  PluginSource,
} from '../shared/plugin-manifest'

import { classifySignedManifestTrust, type ModuleTrustContext } from './modules/module-signature'
import { validateManifestStructure } from './plugin-manifest-validate'

export type PluginRegistryOptions = {
  bundledRoot: string
  userRoot?: string
  providerTrustContext?: ModuleTrustContext
  productionMode?: boolean
  allowUnsignedExecutableAdapters?: boolean
}

export type PluginRegistry = {
  load: () => Promise<PluginRegistryLoadReport>
  loadSync: () => PluginRegistryLoadReport
  list: () => PluginRegistryListEntry[]
  listConversationProviders: () => ConversationProviderListEntry[]
  loaded: () => LoadedPlugin[]
  loadedConversationProviders: () => LoadedConversationProvider[]
  get: (id: string) => LoadedPlugin | undefined
  getConversationProvider: (id: string) => LoadedConversationProvider | undefined
  validateManifestSource: (source: string) => PluginManifestValidationResult
}

export type PluginRegistryLoadReport = {
  loaded: LoadedPlugin[]
  loadedConversationProviders: LoadedConversationProvider[]
  rejected: Array<{
    source: 'bundled' | 'user'
    manifestPath: string
    issues: PluginManifestValidationIssue[]
  }>
}

export function defaultUserPluginRoot(): string {
  return join(homedir(), '.multicode', 'plugins')
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>()
  const providers = new Map<string, LoadedConversationProvider>()

  async function loadFromRoot(
    root: string,
    source: 'bundled' | 'user'
  ): Promise<PluginRegistryLoadReport> {
    const loaded: LoadedPlugin[] = []
    const loadedConversationProviders: LoadedConversationProvider[] = []
    const rejected: PluginRegistryLoadReport['rejected'] = []

    if (!existsSync(root)) return { loaded, loadedConversationProviders, rejected }

    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      return { loaded, loadedConversationProviders, rejected }
    }

    for (const entry of entries) {
      const pluginRoot = join(root, entry)
      try {
        const entryStat = await stat(pluginRoot)
        if (!entryStat.isDirectory()) continue
      } catch {
        continue
      }

      const manifestPath = join(pluginRoot, 'plugin.json')
      if (!existsSync(manifestPath)) continue

      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf-8')
      } catch (err) {
        rejected.push({
          source,
          manifestPath,
          issues: [{ path: '', message: `Could not read plugin.json: ${formatError(err)}` }],
        })
        continue
      }

      const result = validateManifestSource(raw)
      if (!result.ok) {
        rejected.push({ source, manifestPath, issues: result.issues })
        continue
      }

      if (result.manifest.id !== entry) {
        rejected.push({
          source,
          manifestPath,
          issues: [
            {
              path: 'id',
              message: `Plugin id "${result.manifest.id}" does not match its containing directory "${entry}".`,
            },
          ],
        })
        continue
      }

      if (result.manifest.kind === 'provider') {
        loadedConversationProviders.push({
          manifest: result.manifest,
          source,
          manifestPath,
          pluginRoot,
          adapter: await classifyProviderAdapter(result.manifest, source, pluginRoot, options),
        })
      } else {
        loaded.push({
          manifest: result.manifest,
          source,
          manifestPath,
          pluginRoot,
        })
      }
    }

    return { loaded, loadedConversationProviders, rejected }
  }

  function loadFromRootSync(
    root: string,
    source: 'bundled' | 'user'
  ): PluginRegistryLoadReport {
    const loaded: LoadedPlugin[] = []
    const loadedConversationProviders: LoadedConversationProvider[] = []
    const rejected: PluginRegistryLoadReport['rejected'] = []

    if (!existsSync(root)) return { loaded, loadedConversationProviders, rejected }

    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      return { loaded, loadedConversationProviders, rejected }
    }

    for (const entry of entries) {
      const pluginRoot = join(root, entry)
      try {
        if (!statSync(pluginRoot).isDirectory()) continue
      } catch {
        continue
      }

      const manifestPath = join(pluginRoot, 'plugin.json')
      if (!existsSync(manifestPath)) continue

      let raw: string
      try {
        raw = readFileSync(manifestPath, 'utf-8')
      } catch (err) {
        rejected.push({
          source,
          manifestPath,
          issues: [{ path: '', message: `Could not read plugin.json: ${formatError(err)}` }],
        })
        continue
      }

      const result = validateManifestSource(raw)
      if (!result.ok) {
        rejected.push({ source, manifestPath, issues: result.issues })
        continue
      }

      if (result.manifest.id !== entry) {
        rejected.push({
          source,
          manifestPath,
          issues: [
            {
              path: 'id',
              message: `Plugin id "${result.manifest.id}" does not match its containing directory "${entry}".`,
            },
          ],
        })
        continue
      }

      if (result.manifest.kind === 'provider') {
        loadedConversationProviders.push({
          manifest: result.manifest,
          source,
          manifestPath,
          pluginRoot,
          adapter: classifyProviderAdapterSync(result.manifest, source, pluginRoot, options),
        })
      } else {
        loaded.push({
          manifest: result.manifest,
          source,
          manifestPath,
          pluginRoot,
        })
      }
    }

    return { loaded, loadedConversationProviders, rejected }
  }

  function mergeBundledAndUser(
    bundled: PluginRegistryLoadReport,
    user: PluginRegistryLoadReport
  ): PluginRegistryLoadReport {
    plugins.clear()
    providers.clear()
    const report: PluginRegistryLoadReport = {
      loaded: [],
      loadedConversationProviders: [],
      rejected: [...bundled.rejected, ...user.rejected],
    }
    for (const plugin of bundled.loaded) {
      plugins.set(plugin.manifest.id, plugin)
      report.loaded.push(plugin)
    }
    for (const plugin of user.loaded) {
      const previous = plugins.get(plugin.manifest.id)
      if (previous) {
        const replacedIndex = report.loaded.findIndex((p) => p.manifest.id === plugin.manifest.id)
        if (replacedIndex >= 0) report.loaded.splice(replacedIndex, 1)
      }
      plugins.set(plugin.manifest.id, plugin)
      report.loaded.push(plugin)
    }
    for (const provider of bundled.loadedConversationProviders) {
      providers.set(provider.manifest.id, provider)
      report.loadedConversationProviders.push(provider)
    }
    for (const provider of user.loadedConversationProviders) {
      const previous = providers.get(provider.manifest.id)
      if (previous) {
        const replacedIndex = report.loadedConversationProviders.findIndex(
          (p) => p.manifest.id === provider.manifest.id
        )
        if (replacedIndex >= 0) report.loadedConversationProviders.splice(replacedIndex, 1)
      }
      providers.set(provider.manifest.id, provider)
      report.loadedConversationProviders.push(provider)
    }
    return report
  }

  return {
    async load(): Promise<PluginRegistryLoadReport> {
      const bundledRoot = resolveRoot(options.bundledRoot)
      const userRoot = resolveRoot(options.userRoot ?? defaultUserPluginRoot())
      const bundled = await loadFromRoot(bundledRoot, 'bundled')
      const user = await loadFromRoot(userRoot, 'user')
      return mergeBundledAndUser(bundled, user)
    },

    loadSync(): PluginRegistryLoadReport {
      const bundledRoot = resolveRoot(options.bundledRoot)
      const userRoot = resolveRoot(options.userRoot ?? defaultUserPluginRoot())
      const bundled = loadFromRootSync(bundledRoot, 'bundled')
      const user = loadFromRootSync(userRoot, 'user')
      return mergeBundledAndUser(bundled, user)
    },

    list(): PluginRegistryListEntry[] {
      return Array.from(plugins.values()).map(manifestToListEntry)
    },

    listConversationProviders(): ConversationProviderListEntry[] {
      return Array.from(providers.values()).map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        source: p.source,
        version: p.manifest.version,
        providerType: p.manifest.providerType,
        models: p.manifest.models,
        supportsDynamicModels: Boolean(p.manifest.openaiCompatible?.modelsPath),
        adapter: p.adapter,
      }))
    },

    loaded(): LoadedPlugin[] {
      return Array.from(plugins.values())
    },

    loadedConversationProviders(): LoadedConversationProvider[] {
      return Array.from(providers.values())
    },

    get(id: string): LoadedPlugin | undefined {
      return plugins.get(id)
    },

    getConversationProvider(id: string): LoadedConversationProvider | undefined {
      return providers.get(id)
    },

    validateManifestSource,
  }
}

export function validateManifestSource(source: string): PluginManifestValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `plugin.json is not valid JSON: ${formatError(err)}` }],
    }
  }
  return validateManifestStructure(parsed)
}

async function classifyProviderAdapter(
  manifest: ConversationProviderManifest,
  source: PluginSource,
  pluginRoot: string,
  options: PluginRegistryOptions
): Promise<ConversationProviderAdapterClassification> {
  return classifyProviderAdapterWithEntryHash(
    manifest,
    source,
    options,
    await readExecutableAdapterEntryHash(manifest, pluginRoot)
  )
}

function classifyProviderAdapterSync(
  manifest: ConversationProviderManifest,
  source: PluginSource,
  pluginRoot: string,
  options: PluginRegistryOptions
): ConversationProviderAdapterClassification {
  return classifyProviderAdapterWithEntryHash(
    manifest,
    source,
    options,
    readExecutableAdapterEntryHashSync(manifest, pluginRoot)
  )
}

function classifyProviderAdapterWithEntryHash(
  manifest: ConversationProviderManifest,
  source: PluginSource,
  options: PluginRegistryOptions,
  entryHash: { ok: true; sha256: string } | { ok: false; message: string } | null
): ConversationProviderAdapterClassification {
  const adapter = manifest.adapter ?? { kind: 'declarative' as const }
  if (adapter.kind === 'declarative') {
    return { kind: 'declarative', execution: 'declarative', trust: 'not_required' }
  }

  if (!entryHash?.ok) {
    return {
      kind: 'trusted-executable',
      execution: 'blocked',
      trust: 'invalid',
      entry: adapter.entry,
      trustError: entryHash?.message ?? 'Executable provider adapter entry is unavailable.',
    }
  }
  if (entryHash.sha256.toLowerCase() !== adapter.sha256.toLowerCase()) {
    return {
      kind: 'trusted-executable',
      execution: 'blocked',
      trust: 'invalid',
      entry: adapter.entry,
      trustError: 'Executable provider adapter entry hash does not match the signed manifest.',
    }
  }

  if (source === 'bundled') {
    return {
      kind: 'trusted-executable',
      execution: 'executable',
      trust: 'trusted',
      entry: adapter.entry,
    }
  }

  const productionMode = options.productionMode ?? true
  if (!manifest.signature) {
    if (!productionMode && options.allowUnsignedExecutableAdapters) {
      return {
        kind: 'trusted-executable',
        execution: 'executable',
        trust: 'unsigned',
        entry: adapter.entry,
        trustError: 'Executable provider adapter is allowed only by the development trust override.',
      }
    }
    return {
      kind: 'trusted-executable',
      execution: 'blocked',
      trust: 'unsigned',
      entry: adapter.entry,
      trustError: providerTrustError('unsigned', productionMode),
    }
  }

  const trust = classifySignedManifestTrust(
    manifest,
    options.providerTrustContext ?? { trustedModules: new Map() }
  )
  if (trust.status === 'trusted') {
    return {
      kind: 'trusted-executable',
      execution: 'executable',
      trust: trust.status,
      entry: adapter.entry,
      fingerprint: trust.fingerprint,
    }
  }

  if (!productionMode && options.allowUnsignedExecutableAdapters && trust.status !== 'invalid') {
    return {
      kind: 'trusted-executable',
      execution: 'executable',
      trust: trust.status,
      entry: adapter.entry,
      fingerprint: trust.fingerprint,
      trustError: 'Executable provider adapter is allowed only by the development trust override.',
    }
  }

  return {
    kind: 'trusted-executable',
    execution: 'blocked',
    trust: trust.status,
    entry: adapter.entry,
    fingerprint: trust.fingerprint,
    trustError: providerTrustError(trust.status, productionMode),
  }
}

async function readExecutableAdapterEntryHash(
  manifest: ConversationProviderManifest,
  pluginRoot: string
): Promise<{ ok: true; sha256: string } | { ok: false; message: string } | null> {
  if (manifest.adapter?.kind !== 'trusted-executable') return null
  try {
    return { ok: true, sha256: sha256(await readFile(resolve(pluginRoot, manifest.adapter.entry))) }
  } catch {
    return { ok: false, message: 'Executable provider adapter entry could not be read for trust validation.' }
  }
}

function readExecutableAdapterEntryHashSync(
  manifest: ConversationProviderManifest,
  pluginRoot: string
): { ok: true; sha256: string } | { ok: false; message: string } | null {
  if (manifest.adapter?.kind !== 'trusted-executable') return null
  try {
    return { ok: true, sha256: sha256(readFileSync(resolve(pluginRoot, manifest.adapter.entry))) }
  } catch {
    return { ok: false, message: 'Executable provider adapter entry could not be read for trust validation.' }
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function providerTrustError(status: ConversationProviderAdapterClassification['trust'], productionMode: boolean): string {
  if (status === 'invalid') return 'Executable provider adapter signature is invalid or the package was tampered with.'
  if (status === 'signed') return 'Executable provider adapter is signed but has not been trusted for execution.'
  if (status === 'unsigned') return productionMode
    ? 'Unsigned executable provider adapters cannot run in production mode.'
    : 'Unsigned executable provider adapter is blocked without a development trust override.'
  return 'Executable provider adapter is not trusted for execution.'
}

function resolveRoot(root: string): string {
  if (isAbsolute(root)) return root
  return resolve(process.cwd(), root)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function manifestToListEntry(plugin: LoadedPlugin): PluginRegistryListEntry {
  const modelSelection = plugin.manifest.modelSelection
  const reasoningSelection = plugin.manifest.reasoningSelection
  const skillIntegration = plugin.manifest.skillIntegration
  const auth = plugin.manifest.auth
  // Derived, never declared: a runtime that is the claude binary redirected at
  // an alternate provider endpoint (zai, kimi-claude) is a hosted model, and
  // pickers group it under "Models via Claude Code". claude-code itself is the
  // host, not hosted.
  const hostedVia =
    plugin.manifest.binary === 'claude' &&
    plugin.manifest.id !== 'claude-code' &&
    typeof plugin.manifest.launch.env?.ANTHROPIC_BASE_URL === 'string'
      ? ('claude-code' as const)
      : undefined
  return {
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    source: plugin.source,
    version: plugin.manifest.version,
    binary: plugin.manifest.binary,
    // Resume capabilities travel to the renderer so it can decide conversation
    // resume synchronously (see PluginRegistryListEntry / agent-cli-resume.ts).
    resumeSession: plugin.manifest.capabilities.resumeSession,
    sessionIdFromCaller: plugin.manifest.capabilities.sessionIdFromCaller,
    // Hooks are the only supported status mechanism (decision of record,
    // 2026-08-31): a CLI without an agentStateSpec cannot report authoritative
    // agent state and is not offered as an agent. Projected as a boolean so
    // every picker gates on the manifest without reaching the main process.
    agentStateCapable: Boolean(plugin.manifest.agentStateSpec),
    // Only the label crosses to the renderer; the secret value never does.
    ...(auth ? { auth: { label: auth.label } } : {}),
    ...(hostedVia ? { hostedVia } : {}),
    // Renderer pickers need the choices, not the arg templates.
    ...(modelSelection
      ? {
          modelSelection: {
            options: (modelSelection.options ?? []).map((option) => ({
              id: option.id,
              ...(option.label ? { label: option.label } : {}),
            })),
            allowCustomId: modelSelection.allowCustomId ?? false,
          },
        }
      : {}),
    // Renderer pickers need the levels + default, not the arg templates.
    ...(reasoningSelection
      ? {
          reasoningSelection: {
            levels: reasoningSelection.levels.map((level) => ({
              id: level.id,
              ...(level.label ? { label: level.label } : {}),
            })),
            ...(reasoningSelection.default ? { default: reasoningSelection.default } : {}),
          },
        }
      : {}),
    ...(skillIntegration
      ? {
          skillIntegration: {
            support: skillIntegration.support,
            harnessId: skillIntegration.harnessId,
            installTargets: (skillIntegration.installTargets ?? []).map((target) => ({
              scope: target.scope,
              path: target.path,
              format: target.format,
              restartRequired: target.restartRequired === true,
            })),
            ...(skillIntegration.invocation
              ? {
                  invocation: {
                    ...skillIntegration.invocation,
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}

export function providerManifestToListEntry(
  provider: LoadedConversationProvider
): ConversationProviderListEntry {
  return {
    id: provider.manifest.id,
    displayName: provider.manifest.displayName,
    source: provider.source,
    version: provider.manifest.version,
    providerType: provider.manifest.providerType,
    models: provider.manifest.models,
    supportsDynamicModels: Boolean(provider.manifest.openaiCompatible?.modelsPath),
    adapter: provider.adapter,
  }
}

export type { PluginManifest, LoadedPlugin, LoadedConversationProvider }
