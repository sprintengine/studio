// Regenerates the bundled connector catalogue from @hotstack/catalogue-snapshot.
//
//   npm run catalogue:generate
//
// Emits two committed files (deterministic: stable id sort, 2-space JSON) and
// one committed payload tree:
//   resources/mcps/catalog.json            inline-MCP connectors (launch surface)
//   resources/marketplace/marketplace.json signed bundles + plugin entries (install surface)
//   resources/marketplace/skills/<id>/     bundled claude-plugin skill payloads
//                                          (offline install source; digest-gated)
//
// App builds and CI never run this — it runs when bumping the snapshot, and
// the outputs are reviewed like any other diff. Multicode-specific launch
// metadata (legacy id aliases, skill pairings, risk levels) lives in
// resources/mcps/catalog-overlay.json and is layered on top here.
//
// ALWAYS run the app-schema gates on the regenerated output BEFORE committing:
//   npm run verify:marketplace-registry && npm run test:main:mcp-catalog
// This script writes the projection verbatim and does not re-validate it —
// a projected entry the app's stricter validator rejects (parseMarketplaceIndex
// fails the WHOLE index on any issue) would otherwise ship as a poisoned seed
// with a green-looking diff.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { loadSnapshot, skillPayloadDir, toMarketplaceIndex, toMulticodeId } = await import('@hotstack/catalogue-snapshot')

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Bundling policy. The full federated index is ~15k entries and mostly noise;
// what ships in the app is a hand-curated set:
//   1. every curated-tier entry (the HotStack registry is PR-reviewed),
//   2. every claude-plugins-official entry (Anthropic-reviewed plugins),
//   3. the REGISTRY_CONNECTORS map below — hand-picked official/canonical MCP
//      servers from the official registry (vendor-published or the clearly
//      canonical community server for a major product). Aggregator proxies,
//      scrapers, and hobby duplicates stay out deliberately; full-index
//      search remains a future hosted-registry feature.
// Every drop is logged — no silent truncation.
// ---------------------------------------------------------------------------
const REGISTRY_CONNECTORS = {
  // Vendor-domain official namespaces
  'com-airtable/mcp': 'Database', // Airtable
  'com-apify/apify-mcp-server': 'Data Extraction', // Apify
  'com-auth0/mcp': 'Security', // Auth0
  'com-cloudflare-mcp/mcp': 'Cloud', // Cloudflare
  'com-gitlab/mcp': 'Code Hosting', // GitLab
  'com-googleapis-run/mcp': 'Cloud', // Google Cloud Run
  'com-microsoft/azure': 'Cloud', // Azure
  'com-microsoft/powerbi-modeling-mcp': 'Analytics', // Power BI
  'com-monday/monday-com': 'Planning', // monday.com
  'com-newrelic/mcp-server': 'Observability', // New Relic
  'com-paypal-mcp/mcp': 'Payments', // PayPal
  'net-todoist/mcp': 'Planning', // Todoist
  'co-huggingface/hf-mcp-server': 'AI Models', // Hugging Face
  'ai-perplexity/mcp-server': 'Search', // Perplexity
  'ai-exa/exa': 'Search', // Exa search
  'io-snyk/mcp': 'Security', // Snyk
  // Official vendor GitHub orgs
  'io-github-aws/aws-mcp': 'Cloud', // AWS
  'io-github-containers/kubernetes-mcp-server': 'Infrastructure', // Kubernetes
  'io-github-firebase/firebase-mcp': 'Cloud', // Firebase
  'io-github-firecrawl/firecrawl-mcp-server': 'Data Extraction', // Firecrawl
  'io-github-googlecloudplatform/gemini-cloud-assist-mcp': 'Cloud', // Google Cloud
  'io-github-hashicorp/terraform-mcp-server': 'Infrastructure', // Terraform
  'io-github-jfrog/jfrog-mcp-server': 'DevOps', // JFrog
  'io-github-mapbox/mcp-server': 'Maps', // Mapbox
  'io-github-mongodb-js/mongodb-mcp-server': 'Database', // MongoDB
  'io-github-neo4j-contrib/mcp-neo4j-aura-manager': 'Database', // Neo4j Aura
  'io-github-pagerduty/pagerduty-mcp': 'Observability', // PagerDuty
  'io-github-planetscale/mcp-server': 'Database', // PlanetScale
  'io-github-posthog/mcp': 'Analytics', // PostHog
  'io-github-redis/mcp-redis': 'Database', // Redis
  'io-github-snowflake-labs/mcp': 'Data Warehouse', // Snowflake
  'io-github-sonarsource/sonarqube-mcp-server': 'Code Quality', // SonarQube
  'io-github-tavily-ai/tavily-mcp': 'Search', // Tavily
  'io-github-chromedevtools/chrome-devtools-mcp': 'Development', // Chrome DevTools (Puppeteer-based; pairs with the anthropic/chrome-devtools-mcp skills plugin)
  'io-github-vercel/next-devtools-mcp': 'Development', // Next.js devtools
  'io-github-zoom/zoom-docs': 'Documentation', // Zoom
  // Canonical community servers for major-product gaps
  'io-github-domdomegg/gmail-mcp': 'Email', // Gmail
  'io-github-domdomegg/google-cal-mcp': 'Calendar', // Google Calendar
  'io-github-domdomegg/google-drive-mcp': 'File Storage', // Google Drive
  'io-github-domdomegg/google-sheets-mcp': 'Productivity', // Google Sheets
  'io-github-cyanheads/obsidian-mcp-server': 'Knowledge', // Obsidian
  'io-github-delorenj/mcp-server-trello': 'Planning', // Trello
  'io-github-taazkareem/clickup': 'Planning', // ClickUp
}


// Each hand-picked entry carries its display category in the same record, so
// adding a connector cannot forget its category (it would ship as 'other').
// Launch-metadata defaults for allowlisted entries with no overlay record.
const DEFAULT_CLIENTS = ['codex', 'claude']
const SECRETY_AUTH = /oauth|token|key|account/i

// Keep in lockstep with riskLevelForRawServer (src/main/agent-config-import.ts):
// same taxonomy, plus auth-string sniffing because catalogue entries carry
// descriptive `auth` metadata (OAuth remotes hold credentials without env vars).
function riskLevelFor(mcp) {
  if ((mcp.envVarNames ?? []).length > 0) return 'secrets'
  if (typeof mcp.auth === 'string' && SECRETY_AUTH.test(mcp.auth)) return 'secrets'
  return mcp.transport === 'stdio' ? 'local-command' : 'network'
}

function logoDataUri(logoSlug) {
  if (!logoSlug) return undefined
  try {
    const svgPath = require.resolve(`@hotstack/catalogue-snapshot/logos/${logoSlug}.svg`)
    return `data:image/svg+xml;base64,${readFileSync(svgPath).toString('base64')}`
  } catch {
    return undefined
  }
}

// Every server gets SOME icon: without one, McpBrandIcon falls back to a
// simple-icons CDN lookup keyed by the raw id, which 404s for generated
// reverse-DNS ids (com-microsoft-azure, ...) on every render.
const FALLBACK_ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#8b8b8b" fill-opacity="0.18"/><path d="M9 8v3a3 3 0 0 0 6 0V8" fill="none" stroke="#8b8b8b" stroke-width="1.7" stroke-linecap="round"/><path d="M9.5 8V5.5M14.5 8V5.5M12 14v4.5" fill="none" stroke="#8b8b8b" stroke-width="1.7" stroke-linecap="round"/></svg>',
  'utf8'
).toString('base64')}`

const snapshot = loadSnapshot()
const overlay = JSON.parse(readFileSync(path.join(repoRoot, 'resources', 'mcps', 'catalog-overlay.json'), 'utf8'))

const allowSet = new Set(Object.keys(REGISTRY_CONNECTORS))
const picked = snapshot.entries.filter(
  (entry) =>
    entry.tier === 'curated' ||
    entry.sourceId === 'claude-plugins-official' ||
    (entry.sourceId === 'mcp-official-registry' && allowSet.has(entry.id))
)
const missingAllowlisted = Object.keys(REGISTRY_CONNECTORS).filter((id) => !picked.some((entry) => entry.id === id))
if (missingAllowlisted.length > 0) {
  // An upstream rename or delisting must fail loudly, never shrink silently.
  throw new Error(`allowlisted ids missing from the snapshot: ${missingAllowlisted.join(', ')}`)
}

// --- resources/mcps/catalog.json: inline-MCP entries -> launchable servers ---
const inline = picked.filter((entry) => entry.kind === 'inline-mcp')
const servers = []
const usedServerIds = new Set()
for (const entry of inline.sort((a, b) => (a.id < b.id ? -1 : 1))) {
  const native = entry.native
  const overlayEntry = overlay.entries[entry.id] ?? {}
  const id = overlayEntry.id ?? toMulticodeId(entry.id)
  if (!id || usedServerIds.has(id)) {
    throw new Error(`catalog server id collision or unmappable id for "${entry.id}"`)
  }
  usedServerIds.add(id)
  const mcp = native.mcp
  const icon = logoDataUri(entry.logoSlug) ?? (typeof native.icon === 'string' ? native.icon : FALLBACK_ICON)
  const { id: _alias, ...overlayFields } = overlayEntry
  servers.push({
    id,
    name: native.name,
    category: overlayEntry.category ?? REGISTRY_CONNECTORS[entry.id] ?? native.categories?.[0] ?? 'other',
    description: native.summary,
    transport: mcp.transport,
    ...(mcp.command !== undefined ? { command: mcp.command } : {}),
    ...(mcp.args !== undefined ? { args: mcp.args } : {}),
    ...(mcp.url !== undefined ? { url: mcp.url } : {}),
    clients: DEFAULT_CLIENTS,
    defaultClients: DEFAULT_CLIENTS,
    recommendedScope: 'workspace',
    riskLevel: riskLevelFor(mcp),
    ...(mcp.auth !== undefined ? { auth: mcp.auth } : {}),
    envVarNames: mcp.envVarNames ?? [],
    ...(native.sourceUrl !== undefined ? { sourceUrl: native.sourceUrl } : {}),
    ...(mcp.setupNotes !== undefined ? { setupNotes: mcp.setupNotes } : {}),
    icon,
    ...overlayFields,
  })
}

// Overlay records must always land on a snapshot entry — a dangling key means
// an upstream id changed under us and a legacy alias would silently detach.
const danglingOverlay = Object.keys(overlay.entries).filter(
  (hotstackId) => !inline.some((entry) => entry.id === hotstackId)
)
if (danglingOverlay.length > 0) {
  throw new Error(`overlay entries with no matching snapshot entry: ${danglingOverlay.join(', ')}`)
}

const catalogPath = path.join(repoRoot, 'resources', 'mcps', 'catalog.json')
writeFileSync(catalogPath, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8')

// --- resources/marketplace/marketplace.json: bundles + plugins -> install surface ---
// Signed first-party bundles lead the index: the storefront's Featured rail
// and the onboarding teaser take the first entries as the editorial lead.
const bundlesAndPlugins = picked
  .filter((entry) => entry.kind === 'bundle' || entry.kind === 'plugin')
  .sort(
    (a, b) =>
      (a.kind === 'bundle' ? 0 : 1) - (b.kind === 'bundle' ? 0 : 1) ||
      (a.id < b.id ? -1 : 1)
  )
const projection = toMarketplaceIndex(bundlesAndPlugins, { inlineIcons: true })

// The snapshot package still names the pre-move registry repo in the `source`
// of every signed bundle it projects (4 of them, baked into its data). Left
// alone, a regenerate would quietly walk those URLs back to a repo that does
// not exist, and — worse — the packaged-seed offline install would stop firing:
// packagedMarketplacePluginRelativePath (plugin-download.ts) only serves the
// bundled copy when owner/repo/ref match MARKETPLACE_CANONICAL_SOURCE exactly,
// so a mismatched source silently downgrades an offline install to a network
// fetch. Rewrite them onto the canonical source here, which is what that
// constant already claims to be. Remove this once the snapshot ships the
// current repo.
// This is a plain-node script, so the TypeScript constant is read as text
// rather than imported — the same shape verify-module-sdk-pack.mjs uses to
// assert against the SDK's emitted types. Throwing on a miss is deliberate:
// silently falling back to a literal is how the two drifted apart originally.
const canonicalSourceFile = readFileSync(
  path.join(repoRoot, 'src', 'shared', 'marketplace', 'canonical-source.ts'),
  'utf8'
)
const canonicalOwner = canonicalSourceFile.match(/owner:\s*'([^']+)'/)?.[1]
const canonicalRepo = canonicalSourceFile.match(/repo:\s*'([^']+)'/)?.[1]
if (!canonicalOwner || !canonicalRepo) {
  throw new Error('canonical-source.ts: could not read MARKETPLACE_CANONICAL_SOURCE owner/repo.')
}
const PRE_MOVE_SOURCE_PREFIX = 'https://github.com/multicode-labs/marketplace/'
const canonicalSourcePrefix = `https://github.com/${canonicalOwner}/${canonicalRepo}/`
let rewrittenSources = 0
for (const plugin of projection.index.plugins) {
  if (typeof plugin.source !== 'string' || !plugin.source.startsWith(PRE_MOVE_SOURCE_PREFIX)) continue
  plugin.source = `${canonicalSourcePrefix}${plugin.source.slice(PRE_MOVE_SOURCE_PREFIX.length)}`
  rewrittenSources += 1
}

// Repo-authored first-party entries ride through. They are not projected from
// the snapshot, so a regenerate that only wrote the projection would delete
// them — silently, inside a diff too large to notice it in. Two populations
// qualify, and only when the projection did not emit the id (the
// snapshot-owned signed bundles keep coming from the projection, so nothing is
// carried twice):
//   - MC-2036 automation starters: entries owning a committed plugins/<id>/
//     bundle.
//   - MC-1858 inline-CLI entries (`cli` block, no bundle): generated from the
//     bundled plugin manifests by `npm run catalogue:cli-entries` and carried
//     verbatim here; cli-entries.test.ts fails the build if they drift.
const marketplacePath = path.join(repoRoot, 'resources', 'marketplace', 'marketplace.json')
const projectedIds = new Set(projection.index.plugins.map((plugin) => plugin.id))
const carried = existsSync(marketplacePath)
  ? (JSON.parse(readFileSync(marketplacePath, 'utf8')).plugins ?? []).filter(
      (plugin) =>
        !projectedIds.has(plugin.id) &&
        (plugin.cli !== undefined ||
          existsSync(path.join(repoRoot, 'resources', 'marketplace', 'plugins', plugin.id, 'plugin.json')))
    )
  : []
projection.index.plugins = [...projection.index.plugins, ...carried]
writeFileSync(marketplacePath, `${JSON.stringify(projection.index, null, 2)}\n`, 'utf8')

// --- resources/marketplace/skills/<id>/: bundled skill payloads -------------
// Every digest-bearing skill in the projected index gets its payload copied
// from the snapshot package, so claude-plugin installs run offline against
// digest-verified local bytes (no GitHub contents walk). The tree is rebuilt
// from scratch — stale payloads from delisted plugins must not linger. A
// digest listing whose payload is missing from the package is a build error,
// never a silent skip: it would ship an entry that claims offline
// installability and then fails integrity at install time.
const skillsRoot = path.join(repoRoot, 'resources', 'marketplace', 'skills')
rmSync(skillsRoot, { recursive: true, force: true })
let payloadPlugins = 0
let payloadFiles = 0
let payloadBytes = 0
let metadataOnlySkills = 0
for (const plugin of projection.index.plugins) {
  const digestSkills = (plugin.skills ?? []).filter(
    (skill) => skill.files !== undefined && skill.contentDigest !== undefined && skill.path
  )
  metadataOnlySkills += (plugin.skills ?? []).length - digestSkills.length
  if (digestSkills.length === 0) continue
  const packageDir = skillPayloadDir(plugin.id)
  if (!packageDir) {
    throw new Error(`plugin "${plugin.id}" carries content digests but has no payload key`)
  }
  for (const skill of digestSkills) {
    const folder = skill.path.split('/').filter(Boolean).pop()
    const src = fileURLToPath(new URL(`${folder}/`, packageDir))
    if (!existsSync(src)) {
      throw new Error(`plugin "${plugin.id}" skill "${skill.name}" records digests but the snapshot package ships no payload at ${src}`)
    }
    cpSync(src, path.join(skillsRoot, plugin.id, folder), { recursive: true })
    payloadFiles += skill.files.length
    payloadBytes += skill.files.reduce((total, file) => total + file.size, 0)
  }
  payloadPlugins += 1
}

// --- Report: what shipped and what was dropped (never silent) ---
const dropped = snapshot.entries.length - picked.length
console.log(
  [
    `snapshot ${snapshot.generatedAt}: ${snapshot.entries.length} entries`,
    `bundled: ${picked.length} (curated ${picked.filter((e) => e.tier === 'curated').length}, claude-plugins-official ${picked.filter((e) => e.sourceId === 'claude-plugins-official').length}, registry allowlist ${picked.filter((e) => e.sourceId === 'mcp-official-registry').length})`,
    `dropped by policy: ${dropped} unlisted official-registry entries (full-index search stays a hosted-registry feature)`,
    `catalog.json: ${servers.length} servers (${servers.filter((s) => s.skill).length} with launch skills)`,
    `marketplace.json: ${projection.index.plugins.length} plugins (${projection.skipped.length} skipped: ${projection.skipped.map((s) => `${s.id} — ${s.reason}`).join('; ') || 'none'}; ${rewrittenSources} source URL(s) rewritten to ${canonicalOwner}/${canonicalRepo})`,
    `repo-authored entries carried through: ${carried.length}${carried.length > 0 ? ` (${carried.map((plugin) => plugin.id).join(', ')})` : ''}`,
    `skill payloads: ${payloadFiles} files, ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB across ${payloadPlugins} plugins under resources/marketplace/skills (${metadataOnlySkills} skills metadata-only — no bundled content)`,
  ].join('\n')
)
