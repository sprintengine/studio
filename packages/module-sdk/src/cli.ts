#!/usr/bin/env node
// multicode-module — packaging and signing CLI for Multicode capability
// module authors. Runs without repo access: everything it needs ships in the
// @multicode/module-sdk tarball.
//
//   keygen           generate an ed25519 signing keypair (private key PEM)
//   pack             validate a module directory and assemble an installable copy
//   sign             write a detached ed25519 signature into manifest.json
//   verify           check a module directory the way the Multicode app will
//   plugin scaffold  create a plugin bundle skeleton
//   plugin pack      validate and assemble an installable plugin bundle
//   plugin sign      write a detached ed25519 signature into plugin.json
//   plugin verify    check a plugin bundle the way the Multicode app will
//
// sign/verify operate on the VALIDATED manifest shape (the same shape the app
// verifies), and sign writes that normalized manifest back to disk so the
// signed bytes on disk are exactly what the app checks.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { BUNDLED_MODULE_IDS, type CapabilityManifest } from './index.js'
import {
  parseThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'
import {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
} from './plugin-manifest.js'
import { generateModuleSigningKeyPair, signManifest, verifyModuleSignature } from './signing.js'

const USAGE = `multicode-module — pack, sign, and verify Multicode capability modules

Usage:
  multicode-module keygen [--out <file>] [--force]
  multicode-module pack <module-dir> [--out <dir>] [--force]
  multicode-module sign <module-dir> --key <private-key.pem>
  multicode-module verify <module-dir>
  multicode-module plugin scaffold <plugin-id> [--out <dir>] [--component <kind>]... [--force]
  multicode-module plugin pack <plugin-dir> [--out <dir>] [--force]
  multicode-module plugin sign <plugin-dir> --key <private-key.pem>
  multicode-module plugin verify <plugin-dir>

keygen writes an ed25519 private key (PKCS#8 PEM) to --out
(default module-signing.key). Keep it out of the module directory and out of
version control; sign derives the public key from it.

pack validates <module-dir>/manifest.json and copies the module into --out
(default packed/<id>) as an installable module directory. node_modules, .git,
and key files (*.key, *.pem) are never copied.

sign validates manifest.json, signs the normalized manifest with --key, and
writes the normalized manifest including the signature back to manifest.json.

verify validates manifest.json and checks its signature exactly like the
Multicode app: exit 0 with the signer fingerprint when valid, exit 1 when
unsigned, tampered, or invalid.

plugin scaffold creates plugin.json plus component placeholders for mcp, skills,
module, and cli by default. Pass --component repeatedly to scaffold only the
kinds you want.

plugin sign signs the normalized plugin.json bundle manifest. plugin pack
validates plugin.json through the marketplace plugin validator, verifies the
signature, checks declared component paths exist, and copies the bundle while
excluding key material.`

type CliIssue = ThirdPartyManifestIssue | MarketplaceManifestIssue

function fail(message: string, issues?: CliIssue[]): never {
  console.error(message)
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
  process.exit(1)
}

function readManifest(moduleDir: string): { manifestPath: string; manifest: CapabilityManifest } {
  const manifestPath = join(moduleDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    fail(`No manifest.json in ${moduleDir}.`)
  }
  const result = parseThirdPartyModuleManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid module manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function readPluginAuthoringManifest(pluginDir: string): { manifestPath: string; manifest: MarketplacePluginAuthoringManifest } {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginAuthoringManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function readPluginManifest(pluginDir: string): { manifestPath: string; manifest: MarketplacePluginManifest } {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function componentId(pluginId: string, suffix: string): string {
  const maxBaseLength = 63 - suffix.length - 1
  const base = pluginId.slice(0, maxBaseLength).replace(/-+$/g, '') || 'plugin'
  return `${base}-${suffix}`
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pluginComponentsFromKinds(kinds: MarketplaceComponentKind[], id: string): MarketplacePluginComponents {
  const components: MarketplacePluginComponents = {}
  for (const kind of kinds) {
    switch (kind) {
      case 'mcp':
        components.mcp = { path: 'mcp/server.json' }
        break
      case 'skills':
        components.skills = { path: `skills/${id}` }
        break
      case 'module':
        components.module = { path: 'module' }
        break
      case 'cli':
        components.cli = { path: 'cli' }
        break
    }
  }
  return components
}

function parseComponentKinds(raw: unknown): MarketplaceComponentKind[] {
  const requested = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [...MARKETPLACE_COMPONENT_KINDS]
  const kinds: MarketplaceComponentKind[] = []
  const issues: MarketplaceManifestIssue[] = []
  for (const [index, value] of requested.entries()) {
    if (typeof value !== 'string' || !MARKETPLACE_COMPONENT_KINDS.includes(value as MarketplaceComponentKind)) {
      issues.push({ path: `component[${index}]`, message: `must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.` })
      continue
    }
    if (!kinds.includes(value as MarketplaceComponentKind)) kinds.push(value as MarketplaceComponentKind)
  }
  if (issues.length > 0) fail('Invalid --component value:', issues)
  return kinds
}

function assertPluginComponentsExist(pluginDir: string, components: MarketplacePluginComponents): void {
  const issues: MarketplaceManifestIssue[] = []
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const component = components[kind]
    if (!component) continue
    if (!existsSync(join(pluginDir, component.path))) {
      issues.push({ path: `components.${kind}.path`, message: `declared path "${component.path}" does not exist.` })
    }
  }
  if (issues.length > 0) fail(`Plugin component paths are missing in ${pluginDir}:`, issues)
}

function uniqueSiblingPath(parent: string, name: string): string {
  let attempt = 0
  while (true) {
    const candidate = join(parent, `.${name}.${process.pid}.${Date.now()}.${attempt}`)
    if (!existsSync(candidate)) return candidate
    attempt += 1
  }
}

function publishPackedDirectory(tempDir: string, outDir: string): void {
  const outParent = dirname(outDir)
  const previousDir = existsSync(outDir) ? uniqueSiblingPath(outParent, `${basename(outDir)}.previous`) : null
  if (previousDir) renameSync(outDir, previousDir)
  try {
    renameSync(tempDir, outDir)
  } catch (error) {
    if (previousDir) {
      try {
        renameSync(previousDir, outDir)
      } catch {
        // Best effort rollback; the original error is more useful to callers.
      }
    }
    throw error
  }
  if (previousDir) rmSync(previousDir, { recursive: true, force: true })
}

function keygen(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
  })
  const outPath = resolve(values.out ?? 'module-signing.key')
  if (existsSync(outPath) && !values.force) {
    fail(`${outPath} already exists. Pass --force to overwrite it.`)
  }
  const keyPair = generateModuleSigningKeyPair()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, keyPair.privateKeyPem, { mode: 0o600 })
  console.log(`Wrote ed25519 private key to ${outPath}`)
  console.log(`Public key fingerprint: ${keyPair.fingerprint}`)
  console.log('Keep this key out of the module directory and out of version control.')
}

function pack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`pack requires a module directory.\n\n${USAGE}`)
  const sourceDir = resolve(moduleDir)
  const { manifest } = readManifest(sourceDir)

  if (BUNDLED_MODULE_IDS.includes(manifest.id)) {
    fail(`id "${manifest.id}" is a reserved bundled module id. Choose a different module id.`)
  }
  const missingEntries: ThirdPartyManifestIssue[] = []
  for (const [key, relPath] of Object.entries(manifest.entry ?? {})) {
    if (typeof relPath === 'string' && !existsSync(join(sourceDir, relPath))) {
      missingEntries.push({ path: `entry.${key}`, message: `declared file "${relPath}" does not exist.` })
    }
  }
  if (missingEntries.length > 0) {
    fail(`Module entry files are missing in ${sourceDir}:`, missingEntries)
  }

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (outDir === sourceDir || outDir.startsWith(sourceDir + '/')) {
    fail('The pack output directory must be outside the module directory.')
  }

  const skipped: string[] = []
  cpSync(sourceDir, outDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = basename(src)
      if (name === 'node_modules' || name === '.git') return false
      if (name.endsWith('.key') || name.endsWith('.pem')) {
        skipped.push(name)
        return false
      }
      return true
    },
  })
  for (const name of skipped) {
    console.warn(`Skipped ${name}: key material is never packed into a module.`)
  }
  const signedNote = manifest.signature ? 'signed' : 'UNSIGNED — run `multicode-module sign` before distributing'
  console.log(`Packed ${manifest.id} (${signedNote}) to ${outDir}`)
}

function signCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`sign requires a module directory.\n\n${USAGE}`)
  if (!values.key) fail('sign requires --key <private-key.pem> (create one with `multicode-module keygen`).')
  const keyPath = resolve(values.key)
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const { manifestPath, manifest } = readManifest(resolve(moduleDir))
  // Sign the validated manifest minus any prior signature (re-signing replaces it).
  const { signature: _prior, ...unsigned } = manifest
  let signature
  try {
    signature = signManifest(unsigned, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signed: CapabilityManifest = { ...unsigned, signature }
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n')
  const { fingerprint } = verifyModuleSignature(signed)
  console.log(`Signed ${manifest.id}; wrote normalized manifest to ${manifestPath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function verifyCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`verify requires a module directory.\n\n${USAGE}`)
  const { manifest } = readManifest(resolve(moduleDir))
  if (!manifest.signature) {
    fail(`${manifest.id} is unsigned. The app will show it as 'unsigned'; sign it with \`multicode-module sign\`.`)
  }
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (manifest changed after signing, or wrong key). ` +
        'The app will refuse to trust it. Re-sign the module.'
    )
  }
  console.log(`${manifest.id}: signature valid`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function pluginScaffold(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      component: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id) fail(`plugin scaffold requires a plugin id.\n\n${USAGE}`)
  const displayName = displayNameFromId(id)
  const components = pluginComponentsFromKinds(parseComponentKinds(values.component), id)
  const outDir = resolve(values.out ?? id)
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to scaffold into it.`)
  }
  const draft = {
    id,
    displayName,
    version: 1,
    publisher: 'Your Name',
    category: 'dev-tools',
    summary: `${displayName} marketplace plugin.`,
    defaultEnabled: false,
    permissions: ['network'],
    components,
  }
  const draftValidation = validateMarketplacePluginAuthoringManifest(draft)
  if (!draftValidation.ok) {
    fail('plugin scaffold cannot create a valid plugin.json from those inputs:', draftValidation.issues)
  }
  mkdirSync(outDir, { recursive: true })

  writeJson(join(outDir, 'plugin.json'), draftValidation.manifest)

  if (components.mcp) {
    writeJson(join(outDir, components.mcp.path), {
      servers: [
        {
          id: componentId(id, 'mcp'),
          name: `${displayName} MCP`,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      ],
    })
  }
  if (components.skills) {
    const skillDir = join(outDir, components.skills.path)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${displayName} skill placeholder.\n---\n\nDescribe when and how this skill should be used.\n`
    )
  }
  if (components.module) {
    const moduleDir = join(outDir, components.module.path)
    mkdirSync(moduleDir, { recursive: true })
    writeJson(join(moduleDir, 'manifest.json'), {
      id: componentId(id, 'module'),
      displayName: `${displayName} Module`,
      version: 1,
      defaultEnabled: false,
      permissions: ['network'],
      entry: { main: 'main.cjs' },
    })
    writeFileSync(join(moduleDir, 'main.cjs'), 'exports.registerMain = () => {}\n')
  }
  if (components.cli) {
    const cliDir = join(outDir, components.cli.path)
    mkdirSync(cliDir, { recursive: true })
    writeJson(join(cliDir, 'plugin.json'), {
      kind: 'cli',
      id: componentId(id, 'cli'),
      displayName: `${displayName} CLI`,
      version: 1,
      binary: 'node',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['node', 'index.js', { spreadIf: 'promptArgs' }] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    })
    writeFileSync(join(cliDir, 'index.js'), 'console.log("Replace this placeholder with your CLI integration.")\n')
  }

  console.log(`Scaffolded marketplace plugin ${id} at ${outDir}`)
  console.log('Run `multicode-module keygen`, then `multicode-module plugin sign`, then `multicode-module plugin verify`.')
}

function pluginPack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin pack requires a plugin directory.\n\n${USAGE}`)
  const sourceDir = resolve(pluginDir)
  const { manifest } = readPluginManifest(sourceDir)
  const { valid } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(`${manifest.id} has an INVALID signature. Re-sign the plugin before packing it.`)
  }
  assertPluginComponentsExist(sourceDir, manifest.components)

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (isInsideOrEqual(sourceDir, outDir)) {
    fail('The plugin pack output directory must be outside the plugin directory.')
  }

  const skipped: string[] = []
  const outParent = dirname(outDir)
  mkdirSync(outParent, { recursive: true })
  const tempDir = uniqueSiblingPath(outParent, `${basename(outDir)}.tmp`)
  try {
    cpSync(sourceDir, tempDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = basename(src)
        if (name === 'node_modules' || name === '.git') return false
        if (name.endsWith('.key') || name.endsWith('.pem')) {
          skipped.push(name)
          return false
        }
        return true
      },
    })
    publishPackedDirectory(tempDir, outDir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    fail(`Could not pack plugin to ${outDir}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  for (const name of skipped) {
    console.warn(`Skipped ${name}: key material is never packed into a plugin.`)
  }
  console.log(`Packed ${manifest.id} (signature valid) to ${outDir}`)
}

function pluginSign(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin sign requires a plugin directory.\n\n${USAGE}`)
  if (!values.key) fail('plugin sign requires --key <private-key.pem> (create one with `multicode-module keygen`).')
  const keyPath = resolve(values.key)
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const { manifestPath, manifest } = readPluginAuthoringManifest(resolve(pluginDir))
  const { signature: _prior, ...unsigned } = manifest
  let signature
  try {
    signature = signManifest(unsigned, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signed: MarketplacePluginManifest = { ...unsigned, signature }
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n')
  const { fingerprint } = verifyModuleSignature(signed)
  console.log(`Signed plugin ${manifest.id}; wrote normalized manifest to ${manifestPath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function pluginVerify(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin verify requires a plugin directory.\n\n${USAGE}`)

  const sourceDir = resolve(pluginDir)
  const authoring = readPluginAuthoringManifest(sourceDir)
  if (!authoring.manifest.signature) {
    fail(`${authoring.manifest.id} is unsigned. The app will refuse to install it; sign it with \`multicode-module plugin sign\`.`)
  }
  const { manifest } = readPluginManifest(sourceDir)
  assertPluginComponentsExist(sourceDir, manifest.components)
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (plugin.json changed after signing, or wrong key). ` +
        'The app will refuse to install it. Re-sign the plugin.'
    )
  }
  console.log(`${manifest.id}: plugin signature valid`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function pluginCommand(args: string[]): void {
  const [command, ...rest] = args
  switch (command) {
    case 'scaffold':
      pluginScaffold(rest)
      break
    case 'pack':
      pluginPack(rest)
      break
    case 'sign':
      pluginSign(rest)
      break
    case 'verify':
      pluginVerify(rest)
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE)
      break
    default:
      fail(`Unknown plugin command "${command}".\n\n${USAGE}`)
  }
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'keygen':
    keygen(rest)
    break
  case 'pack':
    pack(rest)
    break
  case 'sign':
    signCommand(rest)
    break
  case 'verify':
    verifyCommand(rest)
    break
  case 'plugin':
    pluginCommand(rest)
    break
  case 'plugin-scaffold':
    pluginScaffold(rest)
    break
  case 'plugin-pack':
    pluginPack(rest)
    break
  case 'plugin-sign':
    pluginSign(rest)
    break
  case 'plugin-verify':
    pluginVerify(rest)
    break
  case undefined:
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    fail(`Unknown command "${command}".\n\n${USAGE}`)
}
