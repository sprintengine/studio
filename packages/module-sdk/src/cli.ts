#!/usr/bin/env node
// multicode-module — packaging and signing CLI for Multicode capability
// module authors. Runs without repo access: everything it needs ships in the
// @multicode/module-sdk tarball.
//
//   keygen  generate an ed25519 signing keypair (private key PEM)
//   pack    validate a module directory and assemble an installable copy
//   sign    write a detached ed25519 signature into manifest.json
//   verify  check a module directory the way the Multicode app will
//
// sign/verify operate on the VALIDATED manifest shape (the same shape the app
// verifies), and sign writes that normalized manifest back to disk so the
// signed bytes on disk are exactly what the app checks.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { BUNDLED_MODULE_IDS, type CapabilityManifest } from './index.js'
import {
  parseThirdPartyModuleManifest,
  type ThirdPartyManifestIssue,
} from './manifest-validate.js'
import { generateModuleSigningKeyPair, signManifest, verifyModuleSignature } from './signing.js'

const USAGE = `multicode-module — pack, sign, and verify Multicode capability modules

Usage:
  multicode-module keygen [--out <file>] [--force]
  multicode-module pack <module-dir> [--out <dir>] [--force]
  multicode-module sign <module-dir> --key <private-key.pem>
  multicode-module verify <module-dir>

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
unsigned, tampered, or invalid.`

function fail(message: string, issues?: ThirdPartyManifestIssue[]): never {
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
  case undefined:
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    fail(`Unknown command "${command}".\n\n${USAGE}`)
}
