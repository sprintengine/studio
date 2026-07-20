// Assembles the first-party specialist-pack marketplace bundle.
//
//   node scripts/build-specialist-pack.mjs [--out <dir>] [--force]
//
// Packages the un-shipped specialist roles (resources/specialist-pack/, the
// pack-source tree produced by MC-1587 T1) as a CLI-plugin marketplace bundle
// that contributes a Sprint Engine registry root via the CLI manifest's
// `souls.directory` field. Once signed with the Multicode Labs key it installs
// `verified` (no prompt) and its 17 roles resolve as a `plugin:multicode-specialists`
// registry layer (sprintengine_core/role_registry.py precedence stack).
//
// Output layout (default resources/marketplace/plugins/multicode-specialists/):
//   plugin.json                     marketplace BUNDLE manifest — components.cli,
//                                    publisher "Multicode Labs", UNSIGNED here
//   cli/plugin.json                 CLI plugin manifest — souls.directory:"specialist-pack"
//   cli/specialist-pack/roles/*.json + skills/<role>/SKILL.md   the 17 roles, byte-copied
//
// The bundle is expressed as `provides: ['cli']` (derived from components.cli);
// MARKETPLACE_COMPONENT_KINDS is intentionally left unchanged — roles ride the
// existing `cli` kind, no new marketplace component kind (plan decision 4).
//
// DISTRIBUTION IS TWO SIGNING-GATED STEPS THIS SCRIPT DOES NOT PERFORM:
//   1. Sign the assembled bundle with the Multicode Labs private key:
//        multicode-module plugin sign <out-dir> --key <multicode-labs.key.pem>
//      (writes component sha256 digests + the ed25519 `signature` into plugin.json;
//       fingerprint 95ca10be… is trusted in resources/marketplace/trusted-publishers.json).
//   2. Publish the signed bundle to the upstream first-party marketplace repo so
//      it enters the next @hotstack/catalogue-snapshot, from which
//      resources/marketplace/marketplace.json is generated
//      (scripts/generate-connector-catalogue.mjs) — the seed convention. The
//      committed marketplace.json is never hand-edited.
//
// Until both land, the assembled tree is an UNSIGNED build artifact: it must NOT
// be committed under resources/marketplace/plugins/ (an unsigned committed
// payload with no signed marketplace.json entry fails
// resources/marketplace/verify-marketplace.ts). The un-signed local-folder /
// user-global install path (installRoleFolder, MC-1587 T7) needs none of this.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const BUNDLE_ID = 'multicode-specialists'
const DISPLAY_NAME = 'Multicode specialist roles'
const PUBLISHER = 'Multicode Labs'
const SOULS_DIR = 'specialist-pack'

const packSource = path.join(repoRoot, 'resources', 'specialist-pack')
const defaultOut = path.join(repoRoot, 'resources', 'marketplace', 'plugins', BUNDLE_ID)

function parseArgs(argv) {
  let out = defaultOut
  let force = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      const value = argv[i + 1]
      if (!value) fail('--out requires a directory path.')
      out = path.resolve(value)
      i += 1
    } else if (argv[i] === '--force') {
      force = true
    } else {
      fail(`Unknown argument: ${argv[i]}`)
    }
  }
  return { out, force }
}

function fail(message) {
  console.error(`build-specialist-pack: ${message}`)
  process.exit(1)
}

// The pack-source tree must exist and be internally consistent: every role is a
// parseable manifest with an id, every declared implement skill has a SKILL.md,
// and there are no dangling skill directories. A silent partial copy would ship
// a pack that resolves fewer than its 17 roles.
function readPackSource() {
  const rolesDir = path.join(packSource, 'roles')
  const skillsDir = path.join(packSource, 'skills')
  if (!existsSync(rolesDir) || !existsSync(skillsDir)) {
    fail(`pack source is missing roles/ or skills/ under ${path.relative(repoRoot, packSource)} — run MC-1587 T1 first.`)
  }

  const roleFiles = readdirSync(rolesDir).filter((name) => name.endsWith('.json')).sort()
  if (roleFiles.length === 0) fail('pack source has no role manifests.')

  const roleIds = []
  const referencedSkills = new Set()
  for (const file of roleFiles) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(path.join(rolesDir, file), 'utf8'))
    } catch (error) {
      fail(`role manifest ${file} is not valid JSON: ${error.message}`)
    }
    if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
      fail(`role manifest ${file} has no id.`)
    }
    roleIds.push(manifest.id)
    for (const directives of Object.values(manifest.directives ?? {})) {
      for (const directive of directives ?? []) {
        if (directive && typeof directive.skill === 'string') referencedSkills.add(directive.skill)
      }
    }
  }

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const skill of skillDirs) {
    if (!existsSync(path.join(skillsDir, skill, 'SKILL.md'))) {
      fail(`skill directory ${skill} is missing SKILL.md.`)
    }
  }

  const skillSet = new Set(skillDirs)
  const missingSkills = [...referencedSkills].filter((skill) => !skillSet.has(skill)).sort()
  if (missingSkills.length > 0) {
    fail(`role directives reference skills with no directory: ${missingSkills.join(', ')}`)
  }

  return { roleIds: roleIds.sort(), skillDirs }
}

function bundleManifest() {
  // Marketplace BUNDLE manifest (packages/module-sdk/src/plugin-manifest.ts):
  // a third-party module manifest + components + (post-sign) signature. `provides`
  // is derived from components, so declaring components.cli yields provides:['cli'].
  return {
    id: BUNDLE_ID,
    displayName: DISPLAY_NAME,
    version: 1,
    defaultEnabled: false,
    source: 'third-party',
    permissions: [],
    publisher: PUBLISHER,
    category: 'Sprint Engine',
    summary:
      'The first-party Sprint Engine specialist roles (architect, developer, frontend, tester, reviewers, and more) as an installable pack.',
    components: {
      cli: { path: 'cli' },
    },
  }
}

function cliManifest() {
  // CLI plugin manifest (packages/module-sdk/src/cli-manifest.ts). This plugin
  // exists only to contribute the Sprint Engine registry root via `souls`; it is
  // not a launchable agent CLI. The validator still requires launch fields, so
  // they are present but inert (never spawned — capabilities are all false).
  return {
    kind: 'cli',
    id: BUNDLE_ID,
    displayName: DISPLAY_NAME,
    publisher: PUBLISHER,
    version: 1,
    binary: 'true',
    permissionPresets: { default: { label: 'Default', args: [] } },
    launch: { argv: ['{{binary}}'] },
    promptInjection: { mode: 'stdin-pipe' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: false,
      toolUse: false,
      mcpServers: false,
    },
    souls: { directory: SOULS_DIR },
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function main() {
  const { out, force } = parseArgs(process.argv.slice(2))
  const { roleIds, skillDirs } = readPackSource()

  if (existsSync(out)) {
    if (!force) fail(`output directory ${path.relative(repoRoot, out)} already exists; pass --force to overwrite.`)
    rmSync(out, { recursive: true, force: true })
  }

  const cliDir = path.join(out, 'cli')
  const soulsDir = path.join(cliDir, SOULS_DIR)
  mkdirSync(soulsDir, { recursive: true })

  writeJson(path.join(out, 'plugin.json'), bundleManifest())
  writeJson(path.join(cliDir, 'plugin.json'), cliManifest())
  cpSync(path.join(packSource, 'roles'), path.join(soulsDir, 'roles'), { recursive: true })
  cpSync(path.join(packSource, 'skills'), path.join(soulsDir, 'skills'), { recursive: true })

  const rel = (p) => path.relative(repoRoot, p)
  console.log(
    [
      `Assembled ${BUNDLE_ID} bundle at ${rel(out)}`,
      `  ${roleIds.length} roles, ${skillDirs.length} skills → cli/${SOULS_DIR}/`,
      `  bundle manifest: provides:['cli'] (components.cli), publisher "${PUBLISHER}"`,
      `  cli manifest:    souls.directory:"${SOULS_DIR}"`,
      '',
      'UNSIGNED build artifact — do NOT commit under resources/marketplace/plugins/.',
      'Sign before distribution:',
      `  multicode-module plugin sign ${rel(out)} --key <multicode-labs.key.pem>`,
    ].join('\n')
  )
}

main()
