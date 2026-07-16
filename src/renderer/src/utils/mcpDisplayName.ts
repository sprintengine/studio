// Human display names for MCP catalog servers (MC-1646). Several bundled
// catalog entries carry a raw repo/package basename as their `name` — three of
// them are literally "mcp" — and the sprint wizard's Tools step must never
// render a raw server id as a row's primary name. Resolution order:
//   1. a curated per-id override (the bundled ids whose names are known-bad),
//   2. the catalog name, cleaned of "MCP"/"Server" filler words,
//   3. a name derived from the id when nothing readable is left.
// The transport/category ids stay available separately as mono meta.

type McpNameSource = {
  id: string
  name: string
  description?: string
  category?: string
}

// Bundled ids whose catalog `name` is a raw package basename rather than a
// product name. Keyed by the catalog id (stable per catalog-overlay.json).
const MCP_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'ai-exa-exa': 'Exa',
  'ai-perplexity-mcp-server': 'Perplexity',
  'com-airtable-mcp': 'Airtable',
  'com-apify-apify-mcp-server': 'Apify',
  'com-auth0-mcp': 'Auth0',
  'com-cloudflare-mcp-mcp': 'Cloudflare',
  'com-gitlab-mcp': 'GitLab',
  'com-microsoft-azure': 'Azure',
  'com-microsoft-powerbi-modeling-mcp': 'Power BI',
  'com-newrelic-mcp-server': 'New Relic',
  'com-paypal-mcp-mcp': 'PayPal',
  'io-github-aws-aws-mcp': 'AWS',
  'io-github-containers-kubernetes-mcp-server': 'Kubernetes',
  'io-github-cyanheads-obsidian-mcp-server': 'Obsidian',
  'io-github-delorenj-mcp-server-trello': 'Trello',
  'io-github-firebase-firebase-mcp': 'Firebase',
  'io-github-firecrawl-firecrawl-mcp-server': 'Firecrawl',
  'io-github-googlecloudplatform-gemini-cloud-assist-mcp': 'Gemini Cloud Assist',
  'io-github-jfrog-jfrog-mcp-server': 'JFrog',
  'io-github-mapbox-mcp-server': 'Mapbox',
  'com-monday-monday-com': 'monday.com',
  'io-github-mongodb-js-mongodb-mcp-server': 'MongoDB',
  'io-github-neo4j-contrib-mcp-neo4j-aura-manager': 'Neo4j Aura',
  'io-github-pagerduty-pagerduty-mcp': 'PagerDuty',
  'io-github-posthog-mcp': 'PostHog',
  'io-github-redis-mcp-redis': 'Redis',
  'io-github-snowflake-labs-mcp': 'Snowflake',
  'io-github-sonarsource-sonarqube-mcp-server': 'SonarQube',
  'io-github-taazkareem-clickup': 'ClickUp',
  'io-github-tavily-ai-tavily-mcp': 'Tavily',
  'io-github-vercel-next-devtools-mcp': 'Next.js DevTools',
  'io-github-zoom-zoom-docs': 'Zoom Docs',
  'io-snyk-mcp': 'Snyk',
  'net-todoist-mcp': 'Todoist',
}

// Words that are packaging noise, never part of a product name.
const FILLER_WORDS = new Set(['mcp', 'server', 'servers', 'oss', 'remote', 'official'])

// Reverse-domain / hosting prefixes that lead many catalog ids.
const ID_PREFIX_TOKENS = new Set(['com', 'net', 'org', 'io', 'ai', 'co', 'dev', 'app', 'github'])

function titleCaseToken(token: string): string {
  if (!token) return token
  // Preserve tokens that already carry deliberate casing (PayPal, GitHub).
  if (/[A-Z]/.test(token.slice(1))) return token
  return token.charAt(0).toUpperCase() + token.slice(1)
}

function cleanName(raw: string): string {
  const tokens = raw
    .split(/[\s._-]+/)
    .filter(Boolean)
    .filter((token) => !FILLER_WORDS.has(token.toLowerCase()))
  // Collapse consecutive duplicates ("firebase-firebase-mcp").
  const deduped = tokens.filter(
    (token, index) => index === 0 || token.toLowerCase() !== tokens[index - 1].toLowerCase(),
  )
  return deduped.map(titleCaseToken).join(' ').trim()
}

function nameFromId(id: string): string {
  const tokens = id.split(/[\s._-]+/).filter(Boolean)
  let start = 0
  while (start < tokens.length - 1 && ID_PREFIX_TOKENS.has(tokens[start].toLowerCase())) start += 1
  return cleanName(tokens.slice(start).join('-'))
}

/**
 * The name a tools list renders for an MCP server. Never returns a raw
 * "mcp"/"…-mcp-server" style id: filler words are stripped and, when nothing
 * readable remains, the name is derived from the id's own tokens.
 */
export function mcpServerDisplayName(server: McpNameSource): string {
  const curated = MCP_DISPLAY_NAME_OVERRIDES[server.id]
  if (curated) return curated
  const cleaned = cleanName(server.name ?? '')
  if (cleaned) return cleaned
  const fromId = nameFromId(server.id)
  if (fromId) return fromId
  // Absolute last resort: whatever the catalog gave us beats an empty row.
  return server.name || server.id
}

/**
 * One-line purpose copy for a tools row: the first sentence of the catalog
 * description, falling back to the category. Multi-paragraph descriptions
 * (some entries append tool changelogs) are cut at the first line break.
 */
export function mcpServerPurpose(server: McpNameSource): string {
  const firstLine = (server.description ?? '').split(/\n/, 1)[0]?.trim() ?? ''
  const sentence = firstLine.split(/(?<=\.)\s/, 1)[0]?.trim() ?? ''
  const purpose = sentence.replace(/\.$/, '')
  if (purpose) return purpose
  return server.category ?? ''
}
