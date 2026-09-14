// The pure half of the release workflow: version arithmetic, the macOS
// updater-manifest merge, the manifest checks, the release body, and the
// unauthenticated reachability checks at the end of the file. Authentication and
// the API client live in release.mjs; nothing here reaches the network on its
// own -- the reachability checks take the fetch they use as an argument, so
// release-lib.test.mjs covers all of it offline.

import { createRequire } from 'node:module'

// js-yaml comes through electron-updater, a direct dependency that parses these
// same manifests inside the shipped app, so the writer here and the reader in
// the app are the same library. Loaded lazily: `release.mjs resolve` runs
// before `npm ci` and never touches YAML.
let yamlModule = null
function yaml() {
  if (!yamlModule) {
    const require = createRequire(import.meta.url)
    yamlModule = createRequire(require.resolve('electron-updater/package.json'))('js-yaml')
  }
  return yamlModule
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(raw) {
  const match = VERSION_RE.exec(String(raw).replace(/^v/, ''))
  if (!match) throw new Error(`Not a release version: ${raw}`)
  const [, major, minor, patch, pre] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: pre ?? null }
}

export function coreVersion(raw) {
  const { major, minor, patch } = parseVersion(raw)
  return `${major}.${minor}.${patch}`
}

export function compareCore(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

// The updater channel a version belongs to, and so the name electron-builder
// gives its manifests (`latest.yml` / `preview.yml`, see publish.channel).
// update-service.ts calls any version with a prerelease part a preview build
// and pins autoUpdater.channel to 'preview'; electron-updater then only follows
// releases whose tag's FIRST prerelease identifier is `preview`. A tag like
// v1.2.0-beta.1 would be a release no installed preview build could ever see,
// so it is refused here rather than published.
export function channelForVersion(raw) {
  const { pre } = parseVersion(raw)
  if (pre === null) return 'latest'
  if (pre === 'preview' || pre.startsWith('preview.')) return 'preview'
  throw new Error(
    `Prerelease ${raw} is not a preview version. Installed preview builds only follow ` +
      `tags shaped vX.Y.Z-preview.N, so this release would reach nobody.`,
  )
}

// The version a preview previews. When package.json already names a version
// newer than anything shipped, that is the release being prepared and previews
// carry it. Otherwise the next patch after the latest stable, so a preview
// always sorts above the stable its users came from.
export function resolvePreviewBase(packageVersion, latestStable) {
  const pkg = coreVersion(packageVersion)
  if (!latestStable || compareCore(pkg, latestStable) > 0) return pkg
  const { major, minor, patch } = parseVersion(latestStable)
  return `${major}.${minor}.${patch + 1}`
}

// Numeric prerelease identifiers compare numerically in semver, so date then run
// number orders every preview, including two on the same day.
export function previewVersion(base, date, runNumber) {
  if (!/^\d{8}$/.test(date)) throw new Error(`Preview date must be YYYYMMDD, got ${date}`)
  if (!Number.isInteger(Number(runNumber)) || Number(runNumber) < 1) {
    throw new Error(`Run number must be a positive integer, got ${runNumber}`)
  }
  return `${coreVersion(base)}-preview.${date}.${Number(runNumber)}`
}

export function utcDateStamp(isoTimestamp) {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) throw new Error(`Not a timestamp: ${isoTimestamp}`)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

// The released commit is recorded in the release body, because the releases
// live in a different repository from the source and their tags point at
// nothing in it. The preview gate and stable promotion both read it back.
const SOURCE_SHA_RE = /<!-- source-sha: ([0-9a-f]{40}) -->/

export function sourceShaMarker(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit sha: ${sha}`)
  return `<!-- source-sha: ${sha} -->`
}

export function sourceShaFromBody(body) {
  return SOURCE_SHA_RE.exec(body ?? '')?.[1] ?? null
}

// Each macOS leg writes its own `<channel>-mac.yml` listing only its own arch.
// Published separately, the second upload replaced the first and one arch lost
// its updater entirely. Merged, electron-updater's MacUpdater picks the file for
// the running arch by whether its url contains "arm64" (artifactName carries
// ${arch}, so both zips are distinguishable).
export function mergeMacManifests(arm64Text, x64Text) {
  const arm64 = yaml().load(arm64Text)
  const x64 = yaml().load(x64Text)
  if (arm64?.version !== x64?.version) {
    throw new Error(`macOS manifests disagree on version: ${arm64?.version} vs ${x64?.version}`)
  }
  const seen = new Set((arm64.files ?? []).map((file) => file.url))
  const files = [...(arm64.files ?? []), ...(x64.files ?? []).filter((file) => !seen.has(file.url))]
  return yaml().dump({ ...arm64, files }, { lineWidth: -1 })
}

const isArm64 = (url) => url.includes('arm64')

// What an installed app needs from one updater manifest. Returns the problems,
// empty when the manifest is usable.
export function checkManifest(text, platform, { version, assetNames }) {
  let doc
  try {
    doc = yaml().load(text)
  } catch (error) {
    return [`does not parse: ${error.message}`]
  }
  const problems = []
  if (doc?.version !== version) problems.push(`names version ${doc?.version}, expected ${version}`)
  const urls = (doc?.files ?? []).map((file) => String(file.url))
  if (urls.length === 0) problems.push('lists no files')
  for (const url of urls) {
    if (!assetNames.includes(url)) problems.push(`lists ${url}, which is not on the release`)
  }
  const zips = urls.filter((url) => url.endsWith('.zip'))
  if (platform === 'mac') {
    // MacUpdater throws ERR_UPDATER_ZIP_FILE_NOT_FOUND without a zip for the
    // running arch: a dmg alone installs by hand and never auto-updates.
    if (!zips.some(isArm64)) problems.push('has no Apple Silicon (arm64) .zip')
    if (!zips.some((url) => !isArm64(url))) problems.push('has no Intel (x64) .zip')
  } else if (platform === 'win') {
    if (!urls.some((url) => url.endsWith('.exe'))) problems.push('has no .exe')
  } else if (platform === 'linux') {
    if (!urls.some((url) => url.endsWith('.AppImage'))) problems.push('has no .AppImage')
  }
  return problems
}

export function manifestNames(channel) {
  return { win: `${channel}.yml`, mac: `${channel}-mac.yml`, linux: `${channel}-linux.yml` }
}

// Installers a complete release carries, beside the manifests.
export function missingInstallers(assetNames) {
  const has = (predicate) => assetNames.some(predicate)
  const missing = []
  if (!has((name) => name.endsWith('.dmg') && isArm64(name))) missing.push('an Apple Silicon .dmg')
  if (!has((name) => name.endsWith('.dmg') && !isArm64(name))) missing.push('an Intel .dmg')
  if (!has((name) => name.endsWith('.exe'))) missing.push('a .exe')
  if (!has((name) => name.endsWith('.AppImage'))) missing.push('an .AppImage')
  return missing
}

// The release body. Commit subjects are listed only when the source repository
// is public: the releases repository is public, and while the source is private
// its commit messages must not leak there.
export function buildReleaseNotes({ version, channel, sourceRepo, sha, sourcePrivate, commits = [] }) {
  const lines = [
    channel === 'preview'
      ? `Preview build of SprintEngine Studio ${version}. Installed preview builds update to newer previews.`
      : `SprintEngine Studio ${version}.`,
  ]
  if (!sourcePrivate) {
    lines.push('', `Built from [\`${sha.slice(0, 12)}\`](https://github.com/${sourceRepo}/commit/${sha}).`)
    if (commits.length > 0) {
      const shown = commits.slice(0, 100)
      lines.push('', '### Changes', '')
      for (const commit of shown) {
        lines.push(`- ${commit.subject} ([\`${commit.sha.slice(0, 7)}\`](https://github.com/${sourceRepo}/commit/${commit.sha}))`)
      }
      if (commits.length > shown.length) lines.push(`- ...and ${commits.length - shown.length} more`)
    }
  }
  lines.push('', sourceShaMarker(sha))
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// What an installed build can actually reach.
//
// Every other check in the release job runs with RELEASES_TOKEN, which reads a
// private or misnamed releases repository perfectly happily -- builds up to
// 0.1.7 followed a private repo and never saw an update, and the job that
// published them was green. The questions below are asked the way the shipped
// updater asks them: with no credential at all, and against github.com rather
// than api.github.com -- the provider stays off the API deliberately, because
// an anonymous API budget is per address and shared with everything else on the
// runner.

const ANONYMOUS_USER_AGENT = 'sprintengine-release'

// fetch is a parameter so the tests can read back exactly what was sent: the
// point of this function is the headers it does NOT carry, and an ambient
// GH_TOKEN picked up by a helper somewhere is the failure it exists to rule
// out. Nothing a caller passes is merged into these headers.
export function anonymousGet(fetchImpl = fetch) {
  return async (url, { accept = 'application/json' } = {}) => {
    let response
    try {
      response = await fetchImpl(url, {
        headers: { accept, 'user-agent': ANONYMOUS_USER_AGENT },
        redirect: 'follow',
      })
    } catch (error) {
      // A DNS blip at the end of a long matrix should be retried, not reported
      // as "the repository is private".
      return { ok: false, status: 0, text: '', error: error.message }
    }
    return { ok: response.ok, status: response.status, text: response.ok ? await response.text() : '' }
  }
}

// The three URLs GitHubProvider hits, in order: the feed it finds a version in,
// the redirect a non-prerelease build resolves the newest stable through, and
// the channel manifest it downloads from the release itself.
export function updaterUrls({ repo, tag, channel }) {
  const releases = `https://github.com/${repo}/releases`
  const manifests = {}
  for (const [platform, name] of Object.entries(manifestNames(channel))) {
    manifests[platform] = `${releases}/download/${encodeURIComponent(tag)}/${name}`
  }
  return { feed: `${releases}.atom`, latestPointer: `${releases}/latest`, manifests }
}

// Feed entries newest first, as tags. The updater reads each entry's link and
// takes the last path segment, so this parses what it parses -- percent-encoded
// there (a tag carrying an `@` arrives as `%40`), plain everywhere else.
const FEED_TAG_RE = /\/releases\/tag\/([^"/<]+)/g

export function feedTags(atomXml) {
  return [...String(atomXml).matchAll(FEED_TAG_RE)].map(([, raw]) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  })
}

// The channel of a tag that may be neither of ours: the feed carries whatever
// anyone has ever published to the repository.
function tagChannel(tag) {
  try {
    return channelForVersion(tag)
  } catch {
    return null
  }
}

const describeResponse = (response) => (response.error ? `failed: ${response.error}` : `HTTP ${response.status}`)

// One unauthenticated pass over a published release. Returns the problems and
// whether waiting could still fix them: GitHub serves the feed and the release
// downloads through a cache that can lag a publish by seconds, while a private
// repository or a preview stacked behind a newer preview answers the same way
// forever and polling those only delays the failure.
export async function checkPublicRelease({ repo, tag, channel, version, assetNames = [], get }) {
  const urls = updaterUrls({ repo, tag, channel })
  // Which channel a user's updater puts this release in is decided by the tag
  // and nothing else, so the two checks that turn on it read the tag rather
  // than the caller's channel. A tag that parses as neither falls through to
  // the stable checks, which are the stricter pair.
  const isPreview = tagChannel(tag) === 'preview'
  const pending = []
  const settled = []
  const result = () => ({ problems: [...pending, ...settled], retryable: settled.length === 0 && pending.length > 0 })

  const feed = await get(urls.feed, { accept: 'application/xml' })
  if (!feed.ok) {
    settled.push(
      `${urls.feed} answered ${describeResponse(feed)} without credentials. That is the first request ` +
        `every installed build makes, so no build can see any release at all. Check ${repo} is public, ` +
        `and that build.publish in package.json names the repository the release was published to.`,
    )
    return result()
  }

  const tags = feedTags(feed.text)
  if (!tags.includes(tag)) {
    pending.push(
      `${tag} is not in ${urls.feed}, which lists ${tags.slice(0, 5).join(', ') || 'no releases at all'}. ` +
        `A release still in draft, or published to a different repository, is invisible in exactly this way.`,
    )
  } else if (isPreview) {
    // An installed preview build takes the FIRST preview entry in the feed, not
    // the highest version, so a preview published behind a newer one reaches
    // nobody however correct its own assets are.
    const newestPreview = tags.find((candidate) => tagChannel(candidate) === 'preview')
    if (newestPreview !== tag) {
      settled.push(
        `${urls.feed} lists ${newestPreview} above ${tag}. Installed preview builds follow the first ` +
          `preview entry in the feed, so they would be offered ${newestPreview} instead of this release.`,
      )
    }
  }

  // Only a stable build reads this, but both channels have something to prove
  // about it: that a stable release is what it resolves to, and that a preview
  // is not.
  const pointer = await get(urls.latestPointer, { accept: 'application/json' })
  const pointerTag = pointer.ok ? parseTagName(pointer.text) : null
  if (isPreview) {
    if (pointerTag === tag) {
      settled.push(
        `${urls.latestPointer} resolves to ${tag}, a preview. Every installed stable build resolves its ` +
          `next version through that URL, so all of them would be offered a preview. Publish previews ` +
          `with --latest=false.`,
      )
    }
  } else if (pointerTag !== tag) {
    pending.push(
      `${urls.latestPointer} answered ${describeResponse(pointer)} and resolves to ${pointerTag ?? 'nothing'}, ` +
        `not ${tag}. Installed stable builds read their next version from there and would not be offered ` +
        `this release; re-run \`gh release edit ${tag} --latest\`.`,
    )
  }

  for (const [platform, url] of Object.entries(urls.manifests)) {
    const manifest = await get(url, { accept: 'text/yaml, application/octet-stream, */*' })
    if (!manifest.ok) {
      pending.push(
        `${url} answered ${describeResponse(manifest)} without credentials. The updater downloads that ` +
          `exact URL once it has found the release, and fails with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND without it.`,
      )
      continue
    }
    // The authenticated pass read these through the assets API; this one reads
    // the bytes the CDN hands a user, which is where a half-finished upload or
    // a stale cached object shows up.
    for (const problem of checkManifest(manifest.text, platform, { version, assetNames })) {
      settled.push(`${url} ${problem}`)
    }
  }

  return result()
}

// github.com answers /releases/latest with the release as JSON when asked for
// it, and the updater reads the tag straight back out of that.
function parseTagName(text) {
  try {
    return JSON.parse(text)?.tag_name ?? null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The publish step and this check are seconds apart, so poll before giving up --
// but only while every problem is one that propagation could still resolve.
export async function verifyPublicRelease(options) {
  const { attempts = 6, delayMs = 10_000, wait = sleep } = options
  let problems = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await checkPublicRelease(options)
    problems = outcome.problems
    if (problems.length === 0 || !outcome.retryable) return problems
    if (attempt < attempts) await wait(delayMs)
  }
  return problems
}
