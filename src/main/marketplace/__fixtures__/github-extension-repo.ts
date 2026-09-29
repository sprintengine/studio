// One extension repository on GitHub, at one commit, answering the calls an
// install from its URL makes — in GitHub's own response shapes: the
// repository object, the `application/vnd.github.sha` commit body, contents
// listings with their `download_url`s, and the raw bytes. Laid out the way the
// SDK's templates scaffold a repository: plugin.json at the root naming a
// module/ folder whose manifest carries its `files` digests. Tests use it so
// nothing reaches the network.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { MarketplacePluginDownloadFetch } from '../plugin-download'

export const OWNER = 'acme'
export const REPO = 'notes-ext'
export const SHA = 'a1b2c3d'.padEnd(40, '0')
export const API = `https://api.github.com/repos/${OWNER}/${REPO}`

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export const RENDERER = 'export default function register() {}\n'

export function moduleManifest(options: { files?: boolean } = {}): string {
  return `${JSON.stringify(
    {
      id: 'notes-ext',
      displayName: 'Notes',
      version: 1,
      publisher: 'Acme',
      summary: 'Notes, an extension for SprintEngine Studio.',
      defaultEnabled: false,
      source: 'third-party',
      engines: { hostApi: 1 },
      permissions: ['storage'],
      entry: { renderer: 'dist/renderer.mjs' },
      ...(options.files === false ? {} : { files: { 'dist/renderer.mjs': sha256(RENDERER) } }),
    },
    null,
    2,
  )}\n`
}

// plugin.json exactly as the templates scaffold it: unsigned, no component
// digests, pointing at module/.
export const PLUGIN_JSON = `${JSON.stringify(
  {
    id: 'notes-ext',
    displayName: 'Notes',
    version: 1,
    publisher: 'Acme',
    summary: 'Notes, an extension for SprintEngine Studio.',
    defaultEnabled: false,
    source: 'third-party',
    permissions: ['storage'],
    components: { module: { path: 'module' } },
  },
  null,
  2,
)}\n`

export function extensionRepo(overrides: Record<string, string | null> = {}): Record<string, string> {
  const files: Record<string, string | null> = {
    'plugin.json': PLUGIN_JSON,
    'module/manifest.json': moduleManifest(),
    'module/dist/renderer.mjs': RENDERER,
    'src/renderer.tsx': '// the source the bundle was built from; never fetched\n',
    'README.md': '# Notes\n',
    ...overrides,
  }
  return Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== null))
}

export type Served = { requests: string[]; fetcher: MarketplacePluginDownloadFetch }

/**
 * GitHub, as far as these calls go, for one repository at one commit. `files`
 * is the tree at `sha` (default `SHA`); `defaultBranch` names the branch pointing at it.
 */
export function github(
  files: Record<string, string>,
  options: { defaultBranch?: string; missing?: boolean; sha?: string } = {},
): Served {
  const requests: string[] = []
  const defaultBranch = options.defaultBranch ?? 'main'
  const sha = options.sha ?? SHA
  const raw = (path: string) => `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${path}`
  const listing = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue
      const [name, ...rest] = path.slice(prefix.length).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    return [...names].map(([name, type]) => {
      const path = `${prefix}${name}`
      return type === 'file'
        ? { name, path, type, download_url: raw(path), url: `${API}/contents/${path}?ref=${sha}` }
        : { name, path, type, download_url: null, url: `${API}/contents/${path}?ref=${sha}` }
    })
  }
  const fetcher: MarketplacePluginDownloadFetch = async (url, init) => {
    requests.push(url)
    assert.equal(init.redirect, 'error', `${url} is fetched without following redirects`)
    if (options.missing) return new Response('{"message":"Not Found"}', { status: 404 })
    if (url === API) return Response.json({ full_name: `${OWNER}/${REPO}`, default_branch: defaultBranch })
    if (url === `${API}/commits/${defaultBranch}`) return new Response(sha)
    const contents = new RegExp(`^${API}/contents(?:/(.*))?\\?ref=${sha}$`).exec(url)
    if (contents) {
      const path = contents[1] ?? ''
      if (files[path] !== undefined) {
        return Response.json({ name: path.split('/').pop(), path, type: 'file', download_url: raw(path) })
      }
      const entries = listing(path)
      return entries.length > 0 ? Response.json(entries) : new Response('{"message":"Not Found"}', { status: 404 })
    }
    const prefix = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/`
    if (url.startsWith(prefix) && files[url.slice(prefix.length)] !== undefined) {
      return new Response(files[url.slice(prefix.length)])
    }
    return new Response('{"message":"Not Found"}', { status: 404 })
  }
  return { requests, fetcher }
}
