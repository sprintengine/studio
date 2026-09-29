import { resolve } from 'node:path'

import { app, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import type {
  GithubExtensionCheckUpdateResult,
  GithubExtensionResolveResult,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
  McpClientTarget,
  SkillHarness,
} from '../../shared/electron-api'
import type { MarketplaceComponentKind, MarketplacePluginEntry } from '../../shared/marketplace'
import { isRecord } from '../../shared/records'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import type { AppServices } from '../app-services'
import { writeDiagnosticLog } from '../diagnostics-service'
import {
  createMarketplacePluginLifecycleService,
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipt as readInstallReceipt,
  type MarketplacePluginInstallReceipt,
  type MarketplacePluginLifecycleInstallInput,
} from '../marketplace/plugin-lifecycle'
import { consumeTrustToken, issueTrustToken, peekTrustToken } from '../marketplace/trust-tokens'
import { githubReviewChanges, resolveGithubExtension } from '../marketplace/github-extension-source'
import { listKnownWorkspaceRoots } from '../workspace-roots'
import { assertAppSender } from './ipc-sender'
import { readMarketplaceUpdateStates } from '../marketplace/update-detection'
import { defaultUserModuleRoot } from '../modules/user-module-registry'
import { createDefaultMarketplaceRegistryClient } from './marketplace-registry-ipc'
import {
  defaultMarketplacePluginStagingRoot,
  type MarketplaceInstallLog,
  type MarketplacePluginDownloadFetch,
} from '../marketplace/plugin-download'
import { createMarketplacePluginVerifier } from '../marketplace/plugin-verify'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import type { MarketplaceAutomationInstaller } from '../modules/plugin-bundle-installer'
import { notifyRendererModulesChanged } from '../modules/notify-renderer-modules-changed'
import { readModuleTrustContextSync } from '../modules/trust-context'
import { setModuleTrust } from '../modules/trust-store'

export type MarketplacePluginPipelineServices = Pick<AppServices, 'mcpConfigService' | 'getAutomationsAppFrontDoor'>

// The IPC surface also answers "is this a workspace the app has open?" — the
// renderer names the workspace an install writes into, and main checks it.
export type MarketplacePluginIpcServices = MarketplacePluginPipelineServices & Pick<AppServices, 'workspaceSyncService'>

/**
 * The verify + install/uninstall pipeline, built once and shared.
 *
 * Extracted from `registerMarketplacePluginIpc` when the card executor grew an
 * `install.module` verb (G4): a card's Go installs a registry entry through the
 * SAME lifecycle the storefront does — same trust gate, same receipts, same
 * rollback — and a second construction of it in `cards-ipc.ts` would be a
 * second set of those rules to keep in step.
 */
export function createMarketplacePluginPipeline(
  services: MarketplacePluginPipelineServices,
  // Test seam: every download the pipeline makes, verify's and install's.
  options: { fetcher?: MarketplacePluginDownloadFetch } = {},
) {
  const trustContext = () => readModuleTrustContextSync(app.getPath('userData'))
  // Verify/install failures used to be invisible (result objects only, no
  // logging anywhere) — every pipeline event now lands in the diagnostics log.
  const marketplaceLog: MarketplaceInstallLog = (event, detail) => {
    const details = detail === undefined ? undefined : JSON.stringify(detail)
    void writeDiagnosticLog({
      level: event.includes('fail') || event.includes('mismatch') ? 'error' : 'info',
      source: 'marketplace',
      title: 'Marketplace plugin pipeline',
      message: event,
      ...(details ? { details } : {}),
    }).catch(() => undefined)
  }
  // An automation component installs through the Automations module's own front
  // door — the app's single write path for definitions. The module registers
  // after app services are built and can be switched off, so it is resolved at
  // call time and its absence is an explicit failure, never a silent skip.
  const installAutomationDefinition: MarketplaceAutomationInstaller = async (input) => {
    const frontDoor = services.getAutomationsAppFrontDoor()
    if (!frontDoor) {
      return { ok: false, code: 'automations_unavailable', message: 'The Automations module is not running.' }
    }
    const result = await frontDoor.installCatalogueDefinition(input)
    if (!result.ok) return result
    return { ok: true, value: { definition: result.value.definition, alreadyAdded: result.value.alreadyAdded } }
  }
  const verifier = createMarketplacePluginVerifier({
    trustContext,
    stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
    log: marketplaceLog,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })
  const lifecycle = createMarketplacePluginLifecycleService({
    mcpConfigService: services.mcpConfigService,
    trustContext,
    installAutomationDefinition,
    receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
    stagingRoot: defaultMarketplacePluginStagingRoot(app.getPath('userData')),
    resolveSkillHarnesses: () => resolveInstalledSkillHarnesses(),
    // The trust decision the install prompt already took, written through the
    // one trust-store writer the Settings toggle uses — so a trusted install
    // does not land behind a second, identical toggle in Settings → Modules.
    setModuleTrust: async (id, manifestFp) => {
      const { result, previous } = await setModuleTrust(app.getPath('userData'), id, manifestFp)
      return { ...result, previous }
    },
    log: marketplaceLog,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })

  return { trustContext, log: marketplaceLog, verifier, lifecycle }
}

type MarketplaceRegistryReader = {
  read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
}

export function registerMarketplacePluginIpc(
  ipcMain: IpcMain,
  services: MarketplacePluginIpcServices,
  // Test seams: the registry the handlers resolve ids against, and the
  // network a GitHub-URL install reads.
  overrides: { registryReader?: MarketplaceRegistryReader; fetcher?: MarketplacePluginDownloadFetch } = {},
): void {
  const { trustContext, verifier, lifecycle } = createMarketplacePluginPipeline(
    services,
    overrides.fetcher ? { fetcher: overrides.fetcher } : {},
  )
  // One registry reader for verify, install and update detection, so all
  // three share its cache and its bundled-first/override policy.
  let registryReader: MarketplaceRegistryReader | undefined = overrides.registryReader
  const readRegistry = () => (registryReader ??= createDefaultMarketplaceRegistryClient())
  const knownWorkspaceRoots = () => listKnownWorkspaceRoots(services.workspaceSyncService.getSnapshot())

  async function registryEntry(id: string): Promise<MarketplacePluginEntry | { message: string }> {
    const registry = await readRegistry().read()
    if (!registry.ok) return { message: registry.message || 'The marketplace could not be read.' }
    return (
      registry.marketplace.plugins.find((plugin) => plugin.id === id) ?? {
        message: `${id} is not in the marketplace.`,
      }
    )
  }

  // M-F2: the renderer names an entry; main looks it up in its own registry,
  // discloses what installing it would do, and issues the only thing that can
  // approve that install — a one-time token pinned to what was disclosed.
  ipcMain.handle(
    'marketplace:plugins:verify',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginVerifyResult> => {
      try {
        assertAppSender(event)
        const id = isRecord(input) && typeof input.id === 'string' ? input.id.trim() : ''
        if (!id) return invalidVerifyResult('An extension id is required.')
        const entry = await registryEntry(id)
        if ('message' in entry) return invalidVerifyResult(entry.message)
        const result = await verifier.verify(entry)
        if (!result.pin || result.classification === 'invalid') return withoutPin(result)
        return {
          ...result,
          trustToken: issueTrustToken({ entryId: entry.id, source: 'registry', pin: result.pin, entry }),
        }
      } catch (error) {
        return invalidVerifyResult(formatError(error))
      }
    },
  )

  // Install and update take the same envelope: which entry, the token verify
  // issued for it, and where it goes. The token is spent here whatever
  // happens next, so a failed install goes back through verify.
  async function installOrUpdate(
    event: IpcMainInvokeEvent,
    input: unknown,
    run: (input: MarketplacePluginLifecycleInstallInput) => Promise<MarketplacePluginRegistryInstallResult>,
  ): Promise<MarketplacePluginRegistryInstallResult> {
    assertAppSender(event)
    if (!isRecord(input)) return { ok: false, message: 'Install request is invalid.' }
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) return { ok: false, message: 'An extension id is required.' }
    const envelope = installEnvelope(input, knownWorkspaceRoots())
    if (!envelope.ok) return { ok: false, message: envelope.message }

    let grant = null
    if (input.trustToken !== undefined) {
      grant = typeof input.trustToken === 'string' ? consumeTrustToken(input.trustToken, id) : null
      if (!grant) {
        return {
          ok: false,
          message: 'Your approval for this extension expired or was already used. Review it again to install.',
        }
      }
    }
    // The entry the approval was given for, as main resolved it then; with no
    // approval, only the registry's own copy — which installs only if it
    // needs none.
    let entry = grant?.entry
    if (!entry) {
      const found = await registryEntry(id)
      if ('message' in found) return { ok: false, message: found.message }
      entry = found
    }
    return run({ ...envelope.value, entry, grant })
  }

  ipcMain.handle(
    'marketplace:plugins:install-entry',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        const result = await installOrUpdate(event, input, lifecycle.install)
        if (result.ok) notifyRendererModulesChanged()
        return result
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  ipcMain.handle(
    'marketplace:plugins:update-entry',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        return await installOrUpdate(event, input, lifecycle.update)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // The other end of install (G3). The lifecycle has been able to uninstall a
  // receipt since it was written; nothing could call it, so a marketplace
  // install was a one-way door — the files were removable only by hand, and the
  // receipt that says what they were stayed behind either way. It takes the
  // same envelope install does, because removing an MCP component writes the
  // CLI configs and needs the workspace and settings to do it.
  ipcMain.handle(
    'marketplace:plugins:uninstall',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginUninstallResult> => {
      try {
        assertAppSender(event)
        if (!isRecord(input) || typeof input.pluginId !== 'string') {
          return { ok: false, message: 'Plugin id is required.' }
        }
        const envelope = installEnvelope(input, knownWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const uninstall: MarketplacePluginUninstallInput = { ...envelope.value, pluginId: input.pluginId }
        return await lifecycle.uninstall(uninstall)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // Per-installed-entry update detection. The registry client is constructed
  // lazily so it (and its cache read) only exists once a surface asks.
  ipcMain.handle(
    'marketplace:plugins:update-states',
    async (_event, input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult> => {
      try {
        return await readMarketplaceUpdateStates(
          {
            registryReader: readRegistry(),
            receiptStorePath: defaultMarketplacePluginInstallStorePath(app.getPath('userData')),
            moduleRoot: defaultUserModuleRoot,
            trustContext,
          },
          input ?? {},
        )
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // ── Install extension from GitHub ────────────────────────────────────────
  // Any repository a person pastes. Main resolves its default branch (or the
  // ref the URL names) to a commit, reads plugin.json and the components at
  // that commit, and discloses them exactly as verify does for the registry;
  // the token it issues carries the entry, the pin and the repository, so the
  // install needs nothing else from the renderer.
  const receiptStorePath = () => defaultMarketplacePluginInstallStorePath(app.getPath('userData'))

  async function reviewGithubExtension(
    url: string,
    installed: MarketplacePluginInstallReceipt | undefined,
  ): Promise<GithubExtensionResolveResult> {
    const resolved = await resolveGithubExtension(url, {
      trustContext,
      ...(overrides.fetcher ? { fetcher: overrides.fetcher } : {}),
    })
    if (!resolved.ok) return resolved
    const verify = await verifier.verify(resolved.entry, { allowUnsignedCode: true, requireModuleFileDigests: true })
    if (verify.classification === 'invalid' || !verify.pin) {
      return {
        ok: false,
        message: verify.message ?? 'This extension could not be verified.',
        ...(verify.issues ? { issues: verify.issues } : {}),
      }
    }
    const classification = verify.classification
    const receipt = installed ?? (await readInstallReceipt(receiptStorePath(), resolved.entry.id))
    const unsignedCode = classification === 'unsigned' && verify.codeBearing === true
    const trustToken = issueTrustToken({
      entryId: resolved.entry.id,
      source: 'github',
      pin: verify.pin,
      entry: resolved.entry,
      github: resolved.origin,
      allowUnsignedCode: unsignedCode,
    })
    return {
      ok: true,
      trustToken,
      preview: {
        id: resolved.entry.id,
        displayName: resolved.entry.name,
        version: resolved.entry.latest,
        publisher: resolved.entry.publisher,
        summary: resolved.entry.summary,
        provides: resolved.entry.provides.filter((kind): kind is MarketplaceComponentKind => kind !== 'cli'),
        origin: resolved.origin,
        verify: { ...verify, classification },
        ...(receipt
          ? {
              installed: {
                version: receipt.version,
                ...(receipt.source?.kind === 'github' ? { sha: receipt.source.sha } : {}),
                changes: githubReviewChanges(
                  {
                    classification: receipt.classification,
                    ...(receipt.permissions ? { permissions: receipt.permissions } : {}),
                    ...(receipt.mcpDigest ? { mcpDigest: receipt.mcpDigest } : {}),
                    ...(receipt.source ? { source: receipt.source } : {}),
                  },
                  verify,
                  resolved.origin,
                ),
              },
            }
          : {}),
      },
    }
  }

  ipcMain.handle(
    'extensions:github:resolve',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<GithubExtensionResolveResult> => {
      try {
        assertAppSender(event)
        const url = isRecord(input) && typeof input.url === 'string' ? input.url.trim() : ''
        if (!url) return { ok: false, message: 'Paste a GitHub repository URL.' }
        return await reviewGithubExtension(url, undefined)
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  ipcMain.handle(
    'extensions:github:install',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<MarketplacePluginRegistryInstallResult> => {
      try {
        assertAppSender(event)
        if (!isRecord(input) || typeof input.trustToken !== 'string') {
          return { ok: false, message: 'Install request is invalid.' }
        }
        // The token names its entry; only a token issued for a GitHub review
        // installs here, and it is spent whatever happens next.
        const named = peekTrustToken(input.trustToken)
        if (!named || named.source !== 'github') {
          return {
            ok: false,
            message: 'Your approval for this extension expired or was already used. Review it again to install.',
          }
        }
        const envelope = installEnvelope(input, knownWorkspaceRoots())
        if (!envelope.ok) return { ok: false, message: envelope.message }
        const grant = consumeTrustToken(input.trustToken, named.entryId)
        if (!grant?.entry) {
          return {
            ok: false,
            message: 'Your approval for this extension expired or was already used. Review it again to install.',
          }
        }
        // Unsigned code installs only on the person's own "I trust this code",
        // said at the review this token came from.
        if (grant.allowUnsignedCode && input.trustCode !== true) {
          return {
            ok: false,
            classification: 'unsigned',
            message: 'This extension runs unsigned code. Review it again and confirm you trust the code to install it.',
          }
        }
        const result = await lifecycle.install({ ...envelope.value, entry: grant.entry, grant })
        if (result.ok) notifyRendererModulesChanged()
        return result
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )

  // An update is the same review, of whatever the repository's branch points
  // at now. Nothing changes until the person installs it; `reviewRequired`
  // says whether the new commit discloses anything the last approval did not
  // (permissions, MCP servers, signing, source) and so must be shown again.
  ipcMain.handle(
    'extensions:github:check-update',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<GithubExtensionCheckUpdateResult> => {
      try {
        assertAppSender(event)
        const id = isRecord(input) && typeof input.id === 'string' ? input.id.trim() : ''
        if (!id) return { ok: false, message: 'An extension id is required.' }
        const receipt = await readInstallReceipt(receiptStorePath(), id)
        if (receipt?.source?.kind !== 'github') {
          return { ok: false, message: `${id} was not installed from GitHub.` }
        }
        const reviewed = await reviewGithubExtension(receipt.source.url, receipt)
        if (!reviewed.ok) return { ok: false, message: reviewed.message }
        const sha = reviewed.preview.verify.pin?.commitSha
        if (sha && sha === receipt.source.sha) {
          // Nothing to install: the token just issued is left to expire.
          return { ok: true, state: 'current', sha }
        }
        return {
          ok: true,
          state: 'available',
          preview: reviewed.preview,
          trustToken: reviewed.trustToken,
          reviewRequired: (reviewed.preview.installed?.changes.length ?? 1) > 0,
        }
      } catch (error) {
        return { ok: false, message: formatError(error) }
      }
    },
  )
}

type InstallEnvelope = Omit<MarketplacePluginLifecycleInstallInput, 'entry' | 'grant'>

// The renderer-supplied half of an install, checked. `workspaceRoot` is where
// MCP configs and skill copies get written, and a failed update deletes and
// restores paths under it — so it must be a workspace the app has open (M-F7),
// not any folder the renderer names. Skill harnesses are only ever the app's
// own. Settings and clients pass through to the MCP sync, which normalises
// every server it writes.
export function installEnvelope(
  input: Record<string, unknown>,
  openWorkspaceRoots: string[],
): { ok: true; value: InstallEnvelope } | { ok: false; message: string } {
  const value: InstallEnvelope = {}
  if (input.workspaceRoot !== undefined && input.workspaceRoot !== null) {
    if (typeof input.workspaceRoot !== 'string') return { ok: false, message: 'Workspace root is invalid.' }
    const trimmed = input.workspaceRoot.trim()
    if (trimmed) {
      if (!openWorkspaceRoots.includes(resolve(trimmed))) {
        return { ok: false, message: 'Open this workspace in SprintEngine Studio, then install again.' }
      }
      value.workspaceRoot = trimmed
    }
  }
  if (Array.isArray(input.skillHarnesses)) {
    const requested = input.skillHarnesses.filter((harness): harness is string => typeof harness === 'string')
    value.skillHarnesses = SKILL_PACK_HARNESSES.filter((harness) => requested.includes(harness)) as SkillHarness[]
  }
  if (isRecord(input.mcpSettings)) value.mcpSettings = input.mcpSettings as InstallEnvelope['mcpSettings']
  if (Array.isArray(input.mcpClients)) {
    value.mcpClients = input.mcpClients.filter((client): client is McpClientTarget => typeof client === 'string')
  }
  if (typeof input.automationDefaultCli === 'string' && input.automationDefaultCli.trim()) {
    value.automationDefaultCli = input.automationDefaultCli.trim()
  }
  return { ok: true, value }
}

function invalidVerifyResult(message: string): MarketplacePluginVerifyResult {
  return {
    classification: 'invalid',
    permissions: [],
    sourceUrl: '',
    issues: [{ path: 'source', message }],
    message,
  }
}

// A result there is nothing to approve in carries no pin either.
function withoutPin(result: MarketplacePluginVerifyResult): MarketplacePluginVerifyResult {
  const { pin: _pin, ...rest } = result
  return rest
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
