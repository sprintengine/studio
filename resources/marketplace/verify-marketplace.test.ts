import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

import { parseSpawnAgentConfig } from '../../src/main/automations/actions/spawn-agent'
import { parseDefinitionDraft } from '../../src/main/automations/definition-write'
import { computeNextRun, validateScheduleTriggerConfig } from '../../src/main/automations/schedule'
import { skillContentDigest } from '../../src/main/marketplace/skill-content'
import { AUTOMATION_DEFAULT_PERMISSION_PRESET } from '../../src/shared/automations/contracts'

const workDir = mkdtempSync(join(tmpdir(), 'multicode-marketplace-publish-'))
const verifierBundle = join(process.cwd(), 'node_modules', '.cache', 'multicode', 'marketplace-registry-verify-for-test.cjs')
const seedRoot = join(process.cwd(), 'resources', 'marketplace')
const registryWorkflowPath = join(seedRoot, '.github', 'workflows', 'marketplace-registry.yml')

mkdirSync(join(process.cwd(), 'node_modules', '.cache', 'multicode'), { recursive: true })
buildSync({
  entryPoints: [join(process.cwd(), 'resources', 'marketplace', 'verify-marketplace.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: verifierBundle,
})

type VerifyRun = {
  status: number | null
  stdout: string
  stderr: string
}

function copySeedRegistry(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  return root
}

function runVerifier(root: string): VerifyRun {
  const result = spawnSync(process.execPath, [verifierBundle, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function testSampleRegistryPasses(): void {
  const root = copySeedRegistry('valid-registry')
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  // The seed is generated from the HotStack catalogue snapshot: the 4 signed
  // Multicode Labs bundles plus the unsigned plugin/inline-MCP population.
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as { plugins: unknown[] }
  assert.ok(seed.plugins.length >= 4, 'seed registry must carry at least the signed bundles')
  assert.match(result.stdout, new RegExp(`marketplace registry verified \\(${seed.plugins.length} plugins\\)`))
}

function testUnsignedEntriesNeedNoLocalManifest(): void {
  // Unsigned source-bearing entries (the generated claude-plugins-official
  // population) verify without a plugins/<id>/ manifest dir and with a
  // data-URI icon; a signed entry with a missing manifest still fails.
  const root = copySeedRegistry('unsigned-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const unsigned = marketplace.plugins.filter((plugin) => plugin.signature === undefined)
  assert.ok(unsigned.length > 0, 'generated seed must carry unsigned entries')
  for (const plugin of unsigned) {
    assert.ok(plugin.mcp !== undefined || plugin.cli !== undefined || typeof plugin.source === 'string')
  }
  const signed = marketplace.plugins.find((plugin) => plugin.signature !== undefined)
  assert.ok(signed, 'generated seed must carry a signed entry')
  rmSync(join(root, 'plugins', signed.id as string), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${signed.id as string}/plugin.json`))
}

function testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames(): void {
  // Inline-CLI entries may claim a verified publisher without a signature (the
  // referenced plugin ships inside the signed app bundle), but only under a
  // name listed as verified in trusted-publishers.json — an arbitrary name
  // must not wear the badge.
  const root = copySeedRegistry('inline-cli-publisher-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const inlineCli = marketplace.plugins.find((plugin) => plugin.cli !== undefined)
  assert.ok(inlineCli, 'generated seed must carry inline-CLI entries')
  ;(inlineCli.publisher as Record<string, unknown>).name = 'Unknown Author'
  writeFileSync(path, JSON.stringify(marketplace, null, 2))
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified.*trusted-publishers\.json/)
}

function testInlineCliMustReferenceABundledPluginInTheAppRepoLayout(): void {
  // With a bundled plugin tree beside the registry root (the app repo layout),
  // every inline-CLI entry must reference an existing plugin manifest; a
  // dangling pluginId fails the publish. The plain copySeedRegistry roots have
  // no sibling plugins tree (the standalone registry repo case), where the
  // check deliberately does not apply.
  const appRepo = join(workDir, 'inline-cli-app-repo')
  const root = join(appRepo, 'marketplace')
  mkdirSync(appRepo, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  cpSync(join(process.cwd(), 'resources', 'plugins'), join(appRepo, 'plugins'), { recursive: true })
  assert.equal(runVerifier(root).status, 0, 'seed with the full bundled plugin tree must verify')
  rmSync(join(appRepo, 'plugins', 'claude-code'), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /resources\/plugins\/claude-code\/plugin\.json/)
}

function testStrippedSignatureCannotKeepAVerifiedPublisher(): void {
  // Deleting the signature field from a signed entry must NOT leave it claiming
  // a verified publisher: the signature is the only thing that binds a bundle
  // to its publisher, so dropping it has to be visible on the shelf.
  const root = copySeedRegistry('stripped-signature-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const signed = marketplace.plugins.find((plugin) => plugin.signature !== undefined)
  assert.ok(signed, 'generated seed must carry a signed entry')
  delete signed.signature
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified/)
  assert.match(result.stderr, /may not claim one/)
}

function testUnclaimedPayloadDirFails(): void {
  // A committed payload nothing in the index claims is verified by nothing, yet
  // the packaged-seed install path would still stage it.
  const root = copySeedRegistry('orphan-payload-registry')
  cpSync(join(root, 'plugins', 'browser-automation-mcp'), join(root, 'plugins', 'nobody-claims-me'), { recursive: true })

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/nobody-claims-me/)
  assert.match(result.stderr, /no verified marketplace\.json entry/)
}

const AUTOMATION_STARTER_ID = 'dead-code-sweep-automation'
const AUTOMATION_STARTER_PAYLOAD = join('plugins', AUTOMATION_STARTER_ID, 'automation', 'automation.json')

function testUnsignedAutomationPayloadIsDigestChecked(): void {
  // MC-2036: the automation starters ship unsigned, so the digest walk — not a
  // signature — is what stops their committed bytes drifting from the manifest.
  const root = copySeedRegistry('automation-digest-registry')
  const path = join(root, AUTOMATION_STARTER_PAYLOAD)
  const payload = JSON.parse(readFileSync(path, 'utf8')) as { action: { config: { prompt: string } } }
  payload.action.config.prompt = 'Do something else entirely.'
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${AUTOMATION_STARTER_ID}/plugin\\.json`))
  assert.match(result.stderr, /digest does not match committed bytes/)
}

function testUnsignedAutomationPayloadMustParseAsADefinition(): void {
  const root = copySeedRegistry('automation-shape-registry')
  const payloadPath = join(root, AUTOMATION_STARTER_PAYLOAD)
  const manifestPath = join(root, 'plugins', AUTOMATION_STARTER_ID, 'plugin.json')
  const body = '{"name":"No trigger"}\n'
  writeFileSync(payloadPath, body, 'utf8')
  // Re-digest so the payload check, not the digest check, is what fails.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    components: { automation: { files: Array<{ sha256: string }> } }
  }
  manifest.components.automation.files[0].sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /components\.automation\.trigger/)
}

function testUnsignedBundleMayNotCarryCode(): void {
  const root = copySeedRegistry('unsigned-code-registry')
  const manifestPath = join(root, 'plugins', AUTOMATION_STARTER_ID, 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    components: Record<string, unknown>
  }
  manifest.components.module = { path: 'module/index.js' }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /may not carry a module or cli component/)
}

function testInlineIconMustMatchTheCommittedMark(): void {
  // The shipped mark is a base64 blob nobody can review; the committed SVG is
  // what a reviewer reads. They have to be the same bytes.
  const root = copySeedRegistry('icon-drift-registry')
  const markPath = join(root, 'icons', `${AUTOMATION_STARTER_ID}.svg`)
  writeFileSync(markPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"/>\n', 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not match the committed mark/)
}

function testSchemaInvalidRegistryFailsClearly(): void {
  const root = copySeedRegistry('invalid-schema-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  marketplace.schemaVersion = 99
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /marketplace\.json\.schemaVersion/)
  assert.match(result.stderr, /schemaVersion must be 1/)
}

function testTamperedPluginFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-registry')
  const path = join(root, 'plugins', 'browser-automation-mcp', 'plugin.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.displayName = 'Tampered Browser Automation MCP'
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/browser-automation-mcp\/plugin\.json/)
  assert.match(result.stderr, /multicode-module plugin verify failed/)
  assert.match(result.stderr, /INVALID signature/)
}

function testTamperedComponentFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-component-registry')
  const path = join(root, 'plugins', 'browser-automation-mcp', 'mcp', 'server.json')
  const component = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  component.servers = []
  writeFileSync(path, `${JSON.stringify(component, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/browser-automation-mcp\/plugin\.json/)
  assert.match(result.stderr, /multicode-module plugin verify failed/)
  assert.match(result.stderr, /component digests/i)
}

function testEntrySourceOnNonAllowlistedHostFails(): void {
  const root = copySeedRegistry('evil-source-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const target = marketplace.plugins.find((plugin) => plugin.id === 'browser-automation-mcp')
  assert.ok(target, 'seed registry must carry the browser-automation-mcp bundle')
  target.source = 'https://evil.example.com/plugins/browser-automation-mcp'
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\.browser-automation-mcp\.source/)
  assert.match(result.stderr, /allowlist/)
}

function testEntrySourceOnAllowlistedNonCanonicalOwnerPasses(): void {
  const root = copySeedRegistry('non-canonical-owner-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const first = marketplace.plugins.find((plugin) => plugin.id === 'browser-automation-mcp')
  assert.ok(first, 'seed registry must carry the browser-automation-mcp bundle')
  first.source = `https://github.com/another-org/registry/tree/main/plugins/${first.id}`
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /marketplace registry verified/)
}

function testBundledSkillPayloadDigestsGateThePublish(): void {
  const root = copySeedRegistry('skill-payload-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
  const body = '---\nname: probe\n---\n'
  const files = [
    {
      path: 'SKILL.md',
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      size: Buffer.byteLength(body, 'utf8'),
    },
  ]
  marketplace.plugins.push({
    id: 'digest-probe',
    name: 'probe',
    publisher: { name: 'Probe', verified: false },
    summary: 'Digest gate probe.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    provides: ['skills'],
    tags: ['claude-plugin'],
    source: 'https://github.com/acme/probe',
    skills: [{ name: 'probe', description: 'Probe skill.', path: 'skills/probe', files, contentDigest: skillContentDigest(files) }],
  })
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  const payloadDir = join(root, 'skills', 'digest-probe', 'probe')
  mkdirSync(payloadDir, { recursive: true })
  writeFileSync(join(payloadDir, 'SKILL.md'), body, 'utf8')

  // Digest-bearing entry + matching payload verifies.
  const ok = runVerifier(root)
  assert.equal(ok.status, 0, ok.stderr)

  // Tampered payload bytes fail the publish.
  writeFileSync(join(payloadDir, 'SKILL.md'), '---\nname: evil\n---\n', 'utf8')
  const tampered = runVerifier(root)
  assert.equal(tampered.status, 1)
  assert.match(tampered.stderr, /skills\/digest-probe\/probe/)
  assert.match(tampered.stderr, /digest verification/)

  // A digest-bearing entry with no payload dir at all also fails.
  rmSync(join(root, 'skills', 'digest-probe'), { recursive: true, force: true })
  const missing = runVerifier(root)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /skills\/digest-probe/)
  assert.match(missing.stderr, /payload dir is missing/)
}

// The nightly starters (MC-2036). The registry checks above prove the bundles
// are well-formed; these prove the payloads survive the code that actually
// reads them — the install parse, the schedule arm, and the fire-time action
// config — instead of only looking right in the diff.
const STARTER_CADENCES: Array<{ id: string; name: string; timeLocal: string }> = [
  { id: 'dead-code-sweep-automation', name: 'Dead code sweep', timeLocal: '02:00' },
  { id: 'duplication-review-automation', name: 'Duplication review', timeLocal: '02:30' },
  { id: 'unit-test-coverage-automation', name: 'Unit test coverage', timeLocal: '03:00' },
  { id: 'ui-ux-review-automation', name: 'UI & UX review', timeLocal: '03:30' },
  { id: 'merged-pr-seam-review-automation', name: 'Merged-PR seam review', timeLocal: '18:00' },
]

function readStarterPayload(id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(seedRoot, 'plugins', id, 'automation', 'automation.json'), 'utf8')
  ) as Record<string, unknown>
}

function testStarterPayloadsInstallAndArm(): void {
  const fired = new Set<string>()
  for (const starter of STARTER_CADENCES) {
    const payload = readStarterPayload(starter.id)

    // The install path stamps its own id, status and isolation, so the payload
    // must not carry them: a shelf item cannot opt a user out of run isolation,
    // and a payload id would collide across projects and repeat installs.
    for (const forbidden of ['id', 'runInWorktree', 'ownerModuleId', 'sourceCatalogueId', 'sourcePublisher']) {
      assert.equal(payload[forbidden], undefined, `${starter.id} payload must not carry ${forbidden}`)
    }

    const draft = parseDefinitionDraft(payload)
    assert.ok(draft.ok, `${starter.id} must parse through the app's authoritative definition parse`)
    assert.equal(draft.value.name, starter.name)
    assert.equal(draft.value.status, 'enabled')

    const schedule = validateScheduleTriggerConfig(draft.value.trigger.config)
    assert.ok(schedule.ok, `${starter.id} schedule must validate`)
    assert.deepEqual(schedule.value.cadence, { type: 'daily', timeLocal: starter.timeLocal })
    assert.equal(schedule.value.timezone, 'UTC')
    assert.ok(computeNextRun(schedule.value, Date.parse('2026-07-30T12:00:00Z')) !== null)

    // Staggered: five agents, five worktrees and five pull requests at one
    // instant is the load the cadences exist to spread.
    assert.equal(fired.has(starter.timeLocal), false, `${starter.timeLocal} is claimed by two starters`)
    fired.add(starter.timeLocal)

    assert.equal(draft.value.action.kind, 'spawn-agent')
    const action = parseSpawnAgentConfig(draft.value.action.config)
    assert.ok(action.prompt.length > 0)
    // Plain agent, unattended preset by default, and the live CLI fallback.
    assert.equal(action.specialistId, undefined, `${starter.id} must run a plain agent`)
    assert.equal(action.cli, undefined)
    assert.equal(action.permissionPreset, AUTOMATION_DEFAULT_PERMISSION_PRESET)
  }
}

function testStarterPromptsNameTheirDeliverable(): void {
  // The engine composes the pull request title and body itself, so anything a
  // starter wants a human to read has to be a file in the run's diff. A prompt
  // that only says "open a pull request" produces an empty branch and a failed
  // `gh pr create`.
  for (const starter of STARTER_CADENCES) {
    const { prompt } = parseSpawnAgentConfig(
      (readStarterPayload(starter.id).action as { config: unknown }).config
    )
    assert.match(prompt, new RegExp(`reports/${starter.id.replace(/-automation$/, '')}-`), starter.id)
  }
}

function testPublishScriptsTargetRegistryRoot(): void {
  const appPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const verifyScript = appPackage.scripts?.['verify:marketplace-registry'] ?? ''
  assert.match(verifyScript, /verify-marketplace\.ts/)
  assert.doesNotMatch(verifyScript, /--root resources\/marketplace/)

  const workflow = readFileSync(registryWorkflowPath, 'utf8')
  assert.match(workflow, /marketplace\.json/)
  assert.match(workflow, /plugins\/\*\*/)
  assert.match(workflow, /trusted-publishers\.json/)
  assert.match(workflow, /--root "\$GITHUB_WORKSPACE\/registry"/)
  assert.doesNotMatch(workflow, /resources\/marketplace/)
}

try {
  testSampleRegistryPasses()
  testUnsignedEntriesNeedNoLocalManifest()
  testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames()
  testInlineCliMustReferenceABundledPluginInTheAppRepoLayout()
  testStrippedSignatureCannotKeepAVerifiedPublisher()
  testUnclaimedPayloadDirFails()
  testUnsignedAutomationPayloadIsDigestChecked()
  testUnsignedAutomationPayloadMustParseAsADefinition()
  testUnsignedBundleMayNotCarryCode()
  testInlineIconMustMatchTheCommittedMark()
  testSchemaInvalidRegistryFailsClearly()
  testTamperedPluginFailsThroughCliVerify()
  testTamperedComponentFailsThroughCliVerify()
  testEntrySourceOnNonAllowlistedHostFails()
  testEntrySourceOnAllowlistedNonCanonicalOwnerPasses()
  testBundledSkillPayloadDigestsGateThePublish()
  testStarterPayloadsInstallAndArm()
  testStarterPromptsNameTheirDeliverable()
  testPublishScriptsTargetRegistryRoot()
  console.log('marketplace publish validation tests passed')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
